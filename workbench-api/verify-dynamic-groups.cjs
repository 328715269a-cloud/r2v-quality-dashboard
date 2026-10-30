'use strict';

// Isolated synthetic HTTP/SQLite WAL only. --legacy-root verifies exact prod85
// code and its already-issued sessions; no production data or network is used.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto'),{fork}=require('node:child_process');
const {createService,API}=require('./server.cjs'),{snapshot,MODES}=require('./rules.cjs');
const {BUILTIN_GROUPS}=require('./groups.cjs'),Reports=require('../group-workbench/reports.js');
const root=path.resolve(__dirname,'..'),groupPin='isolated-dynamic-group-pin',adminPin='isolated-dynamic-admin-pin';
const legacyHashes={
  'workbench-api/server.cjs':'f15654a22285ac6eb5291c4a815dc7f55b8b509ff98b568c8e50303adb6136fa',
  'workbench-api/rules.cjs':'35ebd623990ac64b445dbeed659d9f2c5e21f04632bcf636ee7ee45487961617',
  'workbench-api/record-index.cjs':'8d38db075f3f5075b58dcb46fb9301d3823d5e54b69cf1d304460cde324d33a0',
  'group-workbench/workflow.js':'99f53e8ba222f9f2055d51f894592555c983efe7746ce7d0d04ba354ac941556'
};
const hashFile=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const event=(task,type,extra={})=>({id:randomUUID(),taskId:task.id,type,...extra});
const groupEvent=(name,mode,groupId='group_'+randomUUID())=>({id:randomUUID(),type:'group_created',taskId:'group:'+groupId,groupId,mode,name});
const who=(role,groupId,mode)=>({role,groupId,mode,name:{annotation:'隔离标注',qc:'隔离质检',acceptance:'隔离验收'}[role]});
async function listen(service){await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));return`http://127.0.0.1:${service.server.address().port}${API}`;}
function client(base){
  async function call(endpoint,{session,body,status=200}={}){
    const response=await fetch(base+endpoint,{method:body?'POST':'GET',headers:{'X-Workbench-Client':'import-delete-v1',...(session?{'X-Workbench-Session':session.token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    const value=await response.json();if(status!==null)assert.equal(response.status,status,JSON.stringify(value));return{status:response.status,value};
  }
  const data=async(...args)=>(await call(...args)).value;
  return{call,data,login:(profile,pin)=>data('session',{body:{profile,pin}})};
}
function peer(directory,source){
  const worker=fork(__filename,['--peer',directory,source||''],{stdio:['ignore','ignore','inherit','ipc']});
  const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Peer timeout')),15000);worker.once('message',value=>{clearTimeout(timer);resolve(value);});worker.once('error',error=>{clearTimeout(timer);reject(error);});worker.once('exit',code=>{clearTimeout(timer);reject(new Error('Peer exit '+code));});});
  return{ready,close:async()=>{if(worker.exitCode!==null)return;await new Promise(resolve=>{worker.once('exit',resolve);worker.send({close:true});});}};
}
async function child(){const factory=process.argv[4]?require(path.join(process.argv[4],'workbench-api/server.cjs')).createService:createService;const service=factory({directory:process.argv[3],groupPin,adminPin,existingDatabaseOnly:true,skipStartupBackup:true,backupIntervalMs:0});process.send({base:await listen(service),pid:process.pid});process.once('message',async()=>{await service.close();process.exit(0);});}
function importDelta(groupId,mode,prefix,count=3){const batch={id:randomUUID(),groupId,mode,date:'2031-02-03',movie:'自定义组隔离影片'+prefix};const tasks=Array.from({length:count},(_,i)=>({id:randomUUID(),tid:prefix+'-'+i,batchId:batch.id,groupId,mode,date:batch.date,movie:batch.movie}));batch.taskIds=tasks.map(task=>task.id);return{tasks,batches:[batch],events:tasks.map(task=>event(task,'dispatch'))};}
async function main(){
  const arg=process.argv.indexOf('--legacy-root'),legacyRoot=arg>=0?path.resolve(process.argv[arg+1]):'';
  if(legacyRoot)assert.deepEqual(Object.fromEntries(Object.keys(legacyHashes).map(file=>[file,hashFile(path.join(legacyRoot,file))])),legacyHashes,'Legacy source must be exact prod85');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'r2v-dynamic-groups-'));
  const service=createService({directory,groupPin,adminPin,skipStartupBackup:true,backupIntervalMs:0}),current=client(await listen(service));
  const other=peer(directory),legacy=legacyRoot?peer(directory,legacyRoot):null;let full;
  const proofs=[],groups=[],initialSchema=service.db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all();let rejected=0;
  const view=task=>snapshot(service.state(),task.id);
  async function save(api,session,delta,extra={}){const before=await api.data('state',{session}),body={id:randomUUID(),revision:before.revision,delta,...extra};return{body,result:await api.data('transactions',{session,body})};}
  async function reject(api,session,delta,status=400,code='INVALID_TRANSACTION',extra={}){const before=service.exportBackup(),body={id:randomUUID(),revision:before.revision,delta,...extra};const response=await api.data('transactions',{session,body,status});assert.equal(response.error.code,code);const after=service.exportBackup();assert.deepEqual(after.state,before.state);assert.deepEqual(after.transactions,before.transactions);assert.equal(after.revision,before.revision);rejected++;}
  try{
    const peerReady=await other.ready,second=client(peerReady.base),old=legacy?client((await legacy.ready).base):second;
    assert.notEqual(peerReady.pid,process.pid);
    const admin=await old.login({name:'admin',role:'admin'},adminPin),oldAnnotation=await old.login(who('annotation','g01','single')),oldQc=await old.login(who('qc','g01','single'),groupPin),oldAcceptance=await old.login(who('acceptance','g01','single'),groupPin);
    const oldImport=await save(old,admin,importDelta('g01','single','OLD',2)),oldTask=oldImport.result.delta.tasks[0];await save(old,oldAnnotation,{events:[event(oldTask,'claim')]});
    const baseline=service.exportBackup();
    const publicBefore=await current.data('groups');assert.deepEqual(publicBefore.groups,BUILTIN_GROUPS);assert.deepEqual(Object.keys(publicBefore).sort(),['groups','revision']);
    assert.deepEqual((await current.data('health')).capabilities.groupManagement,{supported:true,version:1});
    assert.deepEqual(MODES,Object.fromEntries(BUILTIN_GROUPS.map(group=>[group.id,group.defaultMode])));assert(BUILTIN_GROUPS.find(group=>group.id==='s06').retired);
    const unregistered='group_'+randomUUID();await current.data('session',{body:{profile:who('annotation',unregistered,'multi')},status:400});
    await reject(current,admin,importDelta(unregistered,'multi','UNREGISTERED'));
    await current.data('transactions',{body:{id:randomUUID(),revision:service.getRevision(),delta:{events:[groupEvent('未登录组','single')]}},status:401});
    for(const session of [oldAnnotation,oldQc,oldAcceptance])await reject(current,session,{events:[groupEvent('越权组','single')]},403,'FORBIDDEN');
    for(const name of ['', ' '.repeat(4),'a'.repeat(41),'换\n行','控制\u0001字符','隐藏\u202E字符'])await reject(current,admin,{events:[groupEvent(name,'single')]});
    await reject(current,admin,{events:[groupEvent('错误模式','bad')]});
    await reject(current,admin,{events:[groupEvent('篡改原组','single','g01')]});
    const invalidTarget=groupEvent('错误关联','single');invalidTarget.taskId='group:g01';await reject(current,admin,{events:[invalidTarget]});
    const equalId=groupEvent('双重ID','single');equalId.id=equalId.groupId;await reject(current,admin,{events:[equalId]});
    await reject(current,admin,{events:[groupEvent('混合事务','single'),groupEvent('混合事务二','multi')]});
    await reject(current,admin,{...importDelta('g01','single','MIXED'),events:[groupEvent('混合导入','single')]});
    proofs.push('管理员专属且独立原子新增；未登录、其他角色、空/超长/控制字符、非法模式/ID、混合操作均拒绝且零记录变化');
    const directoryLockEvidence=[];
    for(const [name,mode]of [['  精修 A 组  ','single'],['多镜自定义🌟','multi']]){
      const originalPrepare=service.db.prepare,originalExec=service.db.exec,sqlDuringLock=[];let locked=false,started=0,elapsed=0;
      service.db.prepare=function(sql){if(locked)sqlDuringLock.push(sql);return originalPrepare.call(this,sql);};
      service.db.exec=function(sql){if(sql==='BEGIN IMMEDIATE'){started=performance.now();const result=originalExec.call(this,sql);locked=true;return result;}const result=originalExec.call(this,sql);if(locked&&(sql==='COMMIT'||sql==='ROLLBACK')){elapsed=performance.now()-started;locked=false;}return result;};
      const indexBefore=service.performanceStats();
      const created=groupEvent(name,mode),before=service.getRevision(),saved=await save(current,admin,{events:[created]});assert.equal(saved.result.revision,before+1);
      service.db.prepare=originalPrepare;service.db.exec=originalExec;
      assert(!sqlDuringLock.some(sql=>/^SELECT kind,json FROM records/.test(sql)),'Creating a group must not fetch full state under the write lock');
      assert(sqlDuringLock.some(sql=>/ORDER BY revision DESC,ordinal DESC LIMIT 10/.test(sql)),'Only a bounded event tail is needed');
      assert.equal(service.performanceStats().recordsRead,indexBefore.recordsRead);assert.equal(service.performanceStats().projectedTasks,indexBefore.projectedTasks);
      directoryLockEvidence.push({mode,elapsedMs:Number(elapsed.toFixed(3)),queries:sqlDuringLock.length,fullStateRead:false,taskProjectionCount:0});
      const normalized=saved.result.delta.events[0];assert.equal(normalized.name,name.trim());assert.equal(normalized.actor,'admin');assert.equal(normalized.actorRole,'admin');assert(!Object.hasOwn(normalized,'pin'));assert.equal(normalized.groupId,created.groupId);
      assert(saved.result.groups.some(group=>group.id===created.groupId&&group.name===name.trim()));
      // No state request primes the other process before registering identities.
      const annotation=await second.login(who('annotation',created.groupId,mode)),qc=await second.login(who('qc',created.groupId,mode),groupPin),acceptance=await second.login(who('acceptance',created.groupId,mode),groupPin);
      groups.push({id:created.groupId,name:name.trim(),mode,annotation,qc,acceptance,saved});
      assert.deepEqual(await second.data('transactions',{session:admin,body:saved.body}),saved.result);
      assert.deepEqual(await old.data('transactions',{session:admin,body:saved.body}),saved.result);
      assert.equal(service.getRevision(),before+1);
    }
    await reject(current,admin,{events:[groupEvent('精修Ａ组','single')]},409,'DUPLICATE_GROUP_NAME');
    await reject(current,admin,{events:[groupEvent('单镜头５组','single')]},409,'DUPLICATE_GROUP_NAME');
    await reject(current,admin,{events:[groupEvent('不覆盖原ID','single',groups[0].id)]},409,'DUPLICATE_GROUP');
    await save(second,admin,{events:[groupEvent('精修 A 组','multi')]});
    const staleRevision=groups[0].saved.result.revision;assert.deepEqual(await current.data('transactions',{session:admin,body:groups[0].saved.body}),groups[0].saved.result);assert(service.getRevision()>staleRevision);
    proofs.push('自定义中文/英文/表情名云端持久化；单多可同名，模式内全半角/空格/大小写重复防护；两独立进程即时识别新组与旧API幂等重放；新增写锁内不加载全库状态、不投影任务，仅取10条时间尾部');

    // Same revision race cannot create two equivalent directory entries.
    const raceRevision=service.getRevision(),raceName='并发自定义组';const raceBodies=[groupEvent(raceName,'multi'),groupEvent('并发自定义组','multi')].map(row=>({id:randomUUID(),revision:raceRevision,delta:{events:[row]}}));
    const race=await Promise.all([current,second].map((api,index)=>api.call('transactions',{session:admin,body:raceBodies[index],status:null})));assert.deepEqual(race.map(row=>row.status).sort(),[200,409]);const loser=race.findIndex(row=>row.status===409);assert.equal(race[loser].value.error.code,'REVISION_CONFLICT');assert.equal(service.getRevision(),raceRevision+1);
    await reject(current,admin,raceBodies[loser].delta,409,'DUPLICATE_GROUP_NAME');
    const newCatalog=await second.data('groups');assert.equal(newCatalog.groups.filter(group=>group.name===raceName).length,1);assert(newCatalog.groups.every(group=>Object.keys(group).every(key=>['id','name','defaultMode','retired'].includes(key))));
    proofs.push('并发新增同名组只有一次成功，重试返回同名提示；目录无人员、任务、负责人及会话信息');

    for(const group of groups){
      for(const role of ['annotation','qc','acceptance'])await current.data('session',{body:{profile:who(role,group.id,group.mode==='single'?'multi':'single'),pin:groupPin},status:400});
      await reject(current,group.qc,importDelta(group.id,group.mode,'QC-IMPORT'),403,'FORBIDDEN');
      const imported=await save(current,admin,importDelta(group.id,group.mode,'CUSTOM-'+group.mode));group.tasks=imported.result.delta.tasks;
      await save(second,group.annotation,{events:group.tasks.map(task=>event(task,'claim')).concat(group.tasks.map(task=>event(task,'submit')))});
      await reject(current,oldQc,{events:[event(group.tasks[0],'qc_pass')]},403,'FORBIDDEN');
      await save(current,group.qc,{events:[event(group.tasks[0],'qc_fail',{pLevel:'P1',tags:['命名/ID对齐错误'],note:'隔离返修'})]});await save(second,group.annotation,{events:[event(group.tasks[0],'submit')]});
      assert.equal(view(group.tasks[0]).status,'pending_reqc');await save(current,group.qc,{events:group.tasks.map(task=>event(task,'qc_pass'))});
      const task=group.tasks[0];await save(second,oldAcceptance,{events:[event(task,'acceptance_fail',{acceptanceInspection:'fail',expectedUpdatedAt:view(task).updatedAt,acceptanceRound:view(task).acceptanceRound,note:'隔离实检不合格'})]});
      await save(current,group.qc,{events:[event(task,'acceptance_route',{route:'annotation',note:'回原组返修'})]});await save(second,group.annotation,{events:[event(task,'submit')]});await save(current,group.qc,{events:[event(task,'qc_pass')]});
      const setting={id:randomUUID(),type:'group_daily_edit',taskId:'group:'+group.id,groupId:group.id,mode:group.mode,date:Reports.acceptanceDate(new Date().toISOString()),before:{leader:'待填写',total:null,headcount:null},after:{leader:'隔离组长',total:10,headcount:2.5},note:'合成组日设置'};
      await save(current,group.qc,{events:[setting]},{pin:groupPin});await reject(current,oldQc,{events:[{...setting,id:randomUUID()}]},403,'FORBIDDEN',{pin:groupPin});
    }
    const mixed=groups.flatMap(group=>group.tasks.slice(0,2));await save(second,groups[0].acceptance,{events:mixed.map(task=>event(task,'acceptance_pass',{acceptanceInspection:'pass',expectedUpdatedAt:view(task).updatedAt,acceptanceRound:view(task).acceptanceRound,...(task.id===groups[1].tasks[1].id?{acceptanceIssueLevel:'P2'}:{})}))});
    const rejectedTask=groups[0].tasks[2];await save(current,groups[0].acceptance,{events:[event(rejectedTask,'acceptance_reject',{note:'隔离拒绝'})]});
    const batchTask=groups[1].tasks[2];await save(current,groups[1].acceptance,{events:[event(batchTask,'acceptance_fail',{acceptanceInspection:'uninspected',acceptanceBatchId:randomUUID(),expectedUpdatedAt:view(batchTask).updatedAt,acceptanceRound:view(batchTask).acceptanceRound,note:'隔离整批退回'})]});
    assert(mixed.every(task=>view(task).status==='accepted'));assert.equal(view(rejectedTask).status,'rejected');assert.equal(view(batchTask).status,'acceptance_return_pending');
    proofs.push('自定义单多组完成导入→标注→多次质检/验收返修→原组重提→混合实检/P2通过/拒绝/随批退回；现有组日设置及跨组隔离保持');

    for(const group of groups)for(const session of [group.annotation,group.qc]){
      const fullState=await current.data('state?scope=role-v1',{session}),increment=await current.data('state?scope=role-v1&after='+baseline.revision,{session});
      assert.equal(fullState.state.tasks.length,3);assert(fullState.state.tasks.every(task=>task.groupId===group.id));const own=new Set(group.tasks.map(task=>task.id));
      for(const rows of [fullState.state,increment.delta])assert(rows.events.every(row=>row.groupId===group.id||own.has(row.taskId)));
      assert.deepEqual(fullState.groups,increment.groups);assert.equal(fullState.groups.length,newCatalog.groups.length);assert.deepEqual(fullState.state.groups,fullState.groups);
      const noChanges=await current.data('state?scope=role-v1&after='+fullState.revision,{session});assert(noChanges.delta.events.length===0&&noChanges.delta.tasks.length===0);assert.deepEqual(noChanges.groups,fullState.groups);
    }
    proofs.push('角色全量与增量任务仅限本组，公共目录始终随响应携带，空增量也可同步组名；新增组不依赖完整历史下载');
    // Existing pages keep their sessions and legacy operation formats.
    await save(old,oldAnnotation,{events:[event(oldTask,'submit')]});await save(current,oldQc,{events:[event(oldTask,'qc_pass')]});await save(old,oldAcceptance,{events:[event(oldTask,'acceptance_pass')]});assert.equal(view(oldTask).status,'accepted');
    for(const session of [admin,oldAnnotation,oldQc,oldAcceptance])assert.deepEqual((await current.data('session',{session})).profile,session.profile);
    if(legacyRoot)await old.data('session',{body:{profile:who('annotation',groups[0].id,'single')},status:400});
    full=createService({directory,groupPin,adminPin,existingDatabaseOnly:true,relatedValidation:false,skipStartupBackup:true,backupIntervalMs:0});const fullApi=client(await listen(full));
    await save(fullApi,groups[1].qc,{events:[event(batchTask,'acceptance_route',{route:'qc',note:'完整校验路径复查'})]});await save(fullApi,groups[1].qc,{events:[event(batchTask,'qc_repair_done',{note:'复查完成'})]});await save(fullApi,groups[1].acceptance,{events:[event(batchTask,'acceptance_pass')]});
    proofs.push('既有旧页面会话和原事件格式仍在prod85/候选双侧连续提交；新组同时通过完整校验和相关任务快速校验，不修改工作流');
    const state=service.state(),projected=state.tasks.map(view),groupLabel=id=>state.groups.find(group=>group.id===id)?.name||id;
    for(const row of baseline.state.tasks)assert.deepEqual(state.tasks.find(task=>task.id===row.id),row);for(const row of baseline.state.events)assert.deepEqual(state.events.find(event=>event.id===row.id),row);
    for(const group of groups){
      const input={state,tasks:projected.filter(task=>task.mode===group.mode),groups:state.groups,groupLabel,mode:group.mode,groupId:group.id,localDate:Reports.acceptanceDate};
      for(const kind of ['tasks','events','groups','daily']){const rows=Reports.build({...input,kind})[kind].rows.filter(row=>row.groupId===group.id);assert(rows.length>0,kind);assert(rows.every(row=>row.group===group.name));if(kind==='groups'){assert.equal(rows[0].acceptedTIDs,group.mode==='single'?2:3);assert.equal(rows[0].closedTIDs,3);}}
      const first=Reports.acceptanceAccuracy(input);assert.equal(first.total,2);assert.equal(first.passed,1);const actual=Reports.acceptanceP2(input);assert.equal(actual.p2Count,group.mode==='single'?0:1);
    }
    assert.deepEqual((await current.data('backup',{session:admin})).state,state);assert.deepEqual(service.db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all(),initialSchema);assert.equal(service.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert(!fs.existsSync(path.join(directory,'backups')));
    proofs.push('小组/人员/镜头统计、首验与非P2、任务/流水/日报导出使用真实组ID和自定义名称；旧记录逐项保持、结构不迁移、SQLite完整且无重复备份');
    const files=[...Object.keys(legacyHashes),'workbench-api/groups.cjs','group-workbench/reports.js'];
    const result={ok:true,runtime:process.version,checkedAt:new Date().toISOString(),productionDataAccessed:false,legacySourceVerified:!!legacyRoot,legacySourceSha256:legacyRoot?legacyHashes:null,sourceSha256:Object.fromEntries(files.map(file=>[file,hashFile(path.join(root,file))])),rejectedCases:rejected,groupsCreated:state.events.filter(event=>event.type==='group_created').length,transactions:service.getRevision(),tasks:state.tasks.length,events:state.events.length,directoryLockEvidence,proofs};
    if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));return result;
  }finally{if(full)await full.close();await service.close();await other.close();if(legacy)await legacy.close();}
}
if(require.main===module)(process.argv[2]==='--peer'?child():main()).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
