'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {randomUUID,createHash}=require('node:crypto');
const {createService,API}=require('./server.cjs');
const {snapshot,normalizeDelta}=require('./rules.cjs');
const Flow=require('../group-workbench/workflow.js');
const uid=prefix=>`${prefix}_${randomUUID()}`,clone=value=>JSON.parse(JSON.stringify(value));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'r2v-workbench-deletions-'));
const gate=path.join(directory,'delete.enabled'),groupPin='delete-test-group-pin',adminPin='delete-test-admin-pin';
const adminProfile={name:'admin',role:'admin'},workerProfile={name:'测试标注',role:'annotation',mode:'single',groupId:'g01'},qcProfile={name:'测试组长',role:'qc',mode:'single',groupId:'g01'};
const proofs=[];let service,base;const services=[];
function event(task,type,fields={}){return{id:uid('event'),taskId:task.id,type,...fields};}
function imported(tids,movie='隔离删除影片'){
  const batch={id:uid('batch'),mode:'single',groupId:'g01',date:'2026-09-11',movie,taskIds:[]};
  const tasks=tids.map(tid=>({id:uid('task'),tid,movie,date:batch.date,groupId:batch.groupId,mode:batch.mode,batchId:batch.id}));batch.taskIds=tasks.map(task=>task.id);
  return{tasks,batches:[batch],events:tasks.map(task=>event(task,'dispatch'))};
}
function deletions(raw,batch,fields={}){return{events:batch.taskIds.map(id=>{const task=snapshot(raw,id);return event(task,'task_deleted',{batchId:batch.id,expectedUpdatedAt:task.updatedAt,note:'导入错误，删除本批',...fields});})};}
async function request(endpoint,{token,body,method='GET',status=200,capability=true}={}){
  const response=await fetch(base+endpoint,{method,headers:{...(token?{'X-Workbench-Session':token}:{}),...(body?{'Content-Type':'application/json'}:{}),...(capability?{'X-Workbench-Client':'import-delete-v1'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;
}
async function transaction(profile,delta,{pin,...extras}={}){return service.transact({id:randomUUID(),revision:service.getRevision(),delta,pin,...extras},profile);}
function reject(profile,delta,code,{pin,...extras}={}){
  const before=service.exportBackup();assert.throws(()=>service.transact({id:randomUUID(),revision:service.getRevision(),delta,pin,...extras},profile),error=>error.code===code,error=>error?.message);
  assert.deepEqual(service.state(),before.state);assert.equal(service.getRevision(),before.revision);
}
// Frozen compatibility fixtures make this test independent of Demo directories
// and historical workspace release artifacts. See fixtures/README.md.
function sourceFiles(){return ['server.cjs','rules.cjs','../group-workbench/workflow.js','fixtures/workflow-demo-baseline.js','../group-workbench/shared-store.js'].map(name=>path.resolve(__dirname,name));}
function oldStore(file){
  const memory=new Map(),headers=[];const context={JSON,Map,Set,Promise,Number,Error,AbortSignal,crypto:{randomUUID},sessionStorage:{getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)},fetch:(url,options)=>{headers.push(options.headers);return fetch(new URL(url,base),options);}};
  context.window=context;vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});return{store:context.WorkbenchStore.create(),headers};
}
async function main(){
  const sourceHashes=Object.fromEntries(sourceFiles().map(file=>[path.relative(path.resolve(__dirname,'..'),file).replaceAll('\\','/'),hash(file)]));
  service=createService({directory,groupPin,adminPin,importDeleteGatePath:gate});services.push(service);
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${service.server.address().port}${API}`;
  const admin=await request('session',{method:'POST',body:{profile:adminProfile,pin:adminPin}}),worker=await request('session',{method:'POST',body:{profile:workerProfile}});
  assert.deepEqual((await request('health')).capabilities.importDelete,{supported:true,enabled:false});
  const initial=await transaction(adminProfile,imported(['DELETE-A','DELETE-B'])),batch=initial.delta.batches[0],[a,b]=initial.delta.tasks;
  let delta=deletions(service.state(),batch);reject(adminProfile,delta,'IMPORT_DELETE_DISABLED',{pin:adminPin});
  fs.writeFileSync(gate,'test-only gate\n');assert.equal((await request('health')).capabilities.importDelete.enabled,true);
  reject(adminProfile,delta,'PIN_INVALID');reject(adminProfile,delta,'PIN_INVALID',{pin:groupPin});reject(qcProfile,delta,'FORBIDDEN',{pin:adminPin});reject(workerProfile,delta,'FORBIDDEN',{pin:adminPin});
  reject({...workerProfile,role:'acceptance'},delta,'FORBIDDEN',{pin:adminPin});
  reject(adminProfile,{events:delta.events.slice(0,1)},'INVALID_TRANSACTION',{pin:adminPin});
  reject(adminProfile,{events:[delta.events[0],{...delta.events[0],id:uid('event')}]},'INVALID_TRANSACTION',{pin:adminPin});
  reject(adminProfile,{events:[...delta.events,event(a,'claim')]},'INVALID_TRANSACTION',{pin:adminPin});
  reject(adminProfile,{...delta,tasks:imported(['MIXED']).tasks},'INVALID_TRANSACTION',{pin:adminPin});
  reject(adminProfile,{events:delta.events.map(e=>({...e,batchId:uid('batch')}))},'INVALID_TRANSACTION',{pin:adminPin});
  reject(adminProfile,{events:delta.events.map(e=>({...e,expectedUpdatedAt:''}))},'STATE_CONFLICT',{pin:adminPin});
  reject(adminProfile,{events:delta.events.map(e=>({...e,note:''}))},'INVALID_TRANSACTION',{pin:adminPin});
  proofs.push('Server gate defaults closed; every new deletion checks admin role/PIN and exact unmixed complete-batch membership');
  const prior=clone(service.state());
  await transaction(adminProfile,{events:[event(a,'metadata_edit',{batchId:batch.id,before:{tid:a.tid,movie:a.movie},after:{tid:'DELETE-A-RENAMED',movie:'更正影片'},note:'先更正资料'})]},{pin:adminPin});
  reject(adminProfile,delta,'STATE_CONFLICT',{pin:adminPin});
  const current=service.state(),currentDelta=deletions(current,batch);
  for(const type of ['claim','submit','annotator_reject','reject_return','reject_confirm','package_built','package_claimed','qc_pass','qc_fail','acceptance_pass','acceptance_fail','acceptance_route','qc_repair_done','sent_acceptance','unknown_future_work']){
    const altered=clone(current);altered.events.push(event(a,type,{at:new Date(Date.now()+10000).toISOString(),actor:workerProfile.name,workflowVersion:3}));
    assert.throws(()=>normalizeDelta(altered,deletions(altered,batch),adminProfile,{pin:adminPin,checkPin(){},checkDeleteEnabled(){},now:new Date().toISOString()}),error=>error.code==='BATCH_HAS_ACTIVITY');
  }
  const handed=clone(current);handed.batches.push({id:uid('package'),kind:'handoff',taskIds:[a.id]});assert.throws(()=>normalizeDelta(handed,currentDelta,adminProfile,{pin:adminPin,checkPin(){},checkDeleteEnabled(){},now:new Date().toISOString()}),error=>error.code==='BATCH_HAS_ACTIVITY');
  proofs.push('Metadata edits are eligible but stale confirmations fail; every historical work/unknown event or handoff association blocks the whole batch');
  const oldFile=path.resolve(__dirname,'fixtures/shared-store.prod3.js');
  assert.ok(fs.existsSync(oldFile),'Archived production client exists for real compatibility check');const legacy=oldStore(oldFile);await legacy.store.signIn(workerProfile);assert(legacy.store.read().tasks.some(task=>task.id===a.id));
  const newClient=oldStore(path.resolve(__dirname,'../group-workbench/shared-store.js'));await newClient.store.signIn(workerProfile);assert(newClient.headers.every(headers=>headers['X-Workbench-Client']==='import-delete-v1'));assert(legacy.headers.every(headers=>!headers['X-Workbench-Client']));
  const body={id:randomUUID(),revision:service.getRevision(),delta:{events:currentDelta.events.map(e=>({...e,actor:'伪造操作者',actorRole:'annotation',at:'1900-01-01'}))},pin:adminPin};
  const deleted=await request('transactions',{token:admin.token,method:'POST',body});assert.equal(deleted.delta.events.length,2);assert(deleted.delta.events.every(e=>e.actor==='admin'&&e.actorRole==='admin'&&e.at>'2026'&&e.tidAtEvent&&e.movieAtEvent));
  const tombstoneState=service.state();assert.deepEqual(tombstoneState.tasks,prior.tasks);assert.deepEqual(tombstoneState.batches,prior.batches);assert.deepEqual(tombstoneState.events.slice(0,current.events.length),current.events);
  const projection=snapshot(tombstoneState,a.id);assert.equal(projection.deleted,true);assert.equal(projection.status,'deleted');assert.equal(projection.deletedBy,'admin');assert.equal(projection.deletedBatchId,batch.id);assert.equal(projection.deletionReason,'导入错误，删除本批');assert.equal(projection.tid,'DELETE-A-RENAMED');assert.equal(Flow.counts([projection]).total,0);assert.equal(Flow.canBuild({...projection,status:'annotation_done'},'qc'),false);
  const again=await request('transactions',{token:admin.token,method:'POST',body:{...body,pin:undefined}});assert.deepEqual(again,deleted);assert.equal(service.getRevision(),deleted.revision);
  reject(adminProfile,deletions(service.state(),batch),'TASK_DELETED',{pin:adminPin});
  for(const type of ['claim','submit','annotator_reject','package_built','package_claimed','qc_pass','qc_fail','acceptance_pass','acceptance_fail','metadata_edit'])reject(type==='metadata_edit'?adminProfile:workerProfile,{events:[event(a,type)]},'TASK_DELETED',{pin:adminPin});
  const rawNew=await request('state',{token:worker.token}),rawIncrement=await request(`state?after=${initial.revision}`,{token:worker.token});assert.equal(rawNew.state.tasks.length,2);assert(rawIncrement.delta.events.some(e=>e.type==='task_deleted'));
  const oldFull=await request(`state?after=${initial.revision}`,{token:worker.token,capability:false});assert(oldFull.state);assert.equal(oldFull.state.tasks.length,0);assert.equal(oldFull.state.events.length,0);assert.equal(oldFull.state.batches.length,0);
  await legacy.store.refresh();assert.equal(legacy.store.read().tasks.length,0);await newClient.store.refresh();assert.equal(newClient.store.read().tasks.length,2);
  proofs.push('Append-only tombstones preserve original records, normalize audit identity, reject all deleted-ID actions and keep idempotent retries safe');
  proofs.push('Actual archived prod3 shared-store replaces its cached old IDs from a full legacy snapshot; new capability client retains complete raw audit history');
  const recreated=await transaction(adminProfile,imported(['delete-a-renamed','DELETE-B'],'重新导入影片'));
  assert(recreated.delta.tasks.every(t=>![a.id,b.id].includes(t.id)));await legacy.store.refresh();assert.equal(legacy.store.read().tasks.length,2);assert(legacy.store.read().tasks.every(t=>t.batchId===recreated.delta.batches[0].id));
  await legacy.store.transact(state=>({events:[event(state.tasks.find(t=>t.tid==='delete-a-renamed'),'claim')]}));assert.equal(snapshot(service.state(),recreated.delta.tasks[0].id).assignee,workerProfile.name);
  reject(adminProfile,imported(['DELETE-A-RENAMED']),'DUPLICATE_TID');
  const another=await transaction(adminProfile,imported(['REQUIRES-FRESH-PIN'])),anotherBatch=another.delta.batches[0];reject(adminProfile,deletions(service.state(),anotherBatch),'PIN_INVALID');
  fs.unlinkSync(gate);reject(adminProfile,deletions(service.state(),anotherBatch),'IMPORT_DELETE_DISABLED',{pin:adminPin});assert.equal((await request('health')).capabilities.importDelete.enabled,false);fs.writeFileSync(gate,'enabled again');
  proofs.push('Only active TIDs remain globally case-insensitive unique; reimport uses new IDs; old client can claim the replacement while old IDs remain rejected');
  proofs.push('Successful deletion grants no reusable permission; removing the gate blocks the very next deletion');
  const racing=await transaction(adminProfile,imported(['DELETE-CLAIM-RACE'])),raceTask=racing.delta.tasks[0],raceBatch=racing.delta.batches[0],rev=service.getRevision();
  const raceBodies=[{id:randomUUID(),revision:rev,delta:deletions(service.state(),raceBatch),pin:adminPin},{id:randomUUID(),revision:rev,delta:{events:[event(raceTask,'claim')]}}];
  const responses=await Promise.all(raceBodies.map((value,i)=>fetch(base+'transactions',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Session':i?worker.token:admin.token},body:JSON.stringify(value)})));assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);for(const response of responses)await response.json();
  const raced=snapshot(service.state(),raceTask.id);if(raced.deleted)reject(workerProfile,{events:[event(raceTask,'claim')]},'TASK_DELETED');else reject(adminProfile,deletions(service.state(),raceBatch),'BATCH_HAS_ACTIVITY',{pin:adminPin});
  const claimed=await transaction(adminProfile,imported(['CLAIM-WINS']));await transaction(workerProfile,{events:[event(claimed.delta.tasks[0],'claim')]});reject(adminProfile,deletions(service.state(),claimed.delta.batches[0]),'BATCH_HAS_ACTIVITY',{pin:adminPin});
  proofs.push('Concurrent deletion/claim has exactly one winner; neither a deleted task nor a worked import can be revived/deleted by retry');
  const lateHistory=[...tombstoneState.events.filter(e=>e.taskId===a.id),event(a,'claim',{at:'2099-01-01',actor:'旧页面'}),event(a,'submit',{at:'2099-01-02',actor:'旧页面',workflowVersion:3})];const late=Flow.project(a,lateHistory);assert.equal(late.deleted,true);assert.equal(late.status,'deleted');assert.equal(late.updatedAt,projection.deletedAt);assert.equal(late.legacyConflicts.length,2);assert.equal(Flow.eventConflicts(lateHistory).length,2);assert.equal(Flow.effectiveEvents(lateHistory).length,lateHistory.length-2);assert.equal(Flow.label(late),'已删除');
  assert.equal(fs.readFileSync(path.resolve(__dirname,'../group-workbench/workflow.js'),'utf8'),fs.readFileSync(path.resolve(__dirname,'fixtures/workflow-demo-baseline.js'),'utf8'));
  proofs.push('Projection deletion is terminal: later legacy actions remain auditable conflicts but cannot change status, ownership, counts or rounds');
  let full=await request('backup',{token:worker.token,capability:false});assert.deepEqual(full.state,service.state());assert(full.state.tasks.some(t=>t.id===a.id));assert(full.state.events.some(e=>e.type==='task_deleted'));const encoded=JSON.stringify(full);assert(!encoded.includes(adminPin));assert(!encoded.includes(groupPin));assert(!encoded.includes(worker.token));
  const copy=path.join(directory,'online-copy.sqlite');await service.onlineBackup(copy);const restoredDirectory=path.join(directory,'restored');fs.mkdirSync(restoredDirectory);fs.copyFileSync(copy,path.join(restoredDirectory,'workbench.sqlite'));const restored=createService({directory:restoredDirectory,groupPin,adminPin});services.push(restored);assert.deepEqual(restored.state(),full.state);await restored.close();services.splice(services.indexOf(restored),1);
  const beforeSchema=service.db.prepare('PRAGMA schema_version').get().schema_version,beforeRaw=clone(service.state()),mode=fs.statSync(service.dbPath).mode;
  const originalChmod=fs.chmodSync,originalMkdir=fs.mkdirSync;let existing;
  try{fs.chmodSync=()=>{throw Error('Existing-only startup must not chmod');};fs.mkdirSync=()=>{throw Error('Existing-only startup must not mkdir');};existing=createService({directory,groupPin,adminPin,existingDatabaseOnly:true,skipStartupBackup:true,backupIntervalMs:0,importDeleteGatePath:gate});services.push(existing);}finally{fs.chmodSync=originalChmod;fs.mkdirSync=originalMkdir;}
  assert.equal(existing.db.prepare('SELECT total_changes() AS n').get().n,0);assert.equal(existing.db.prepare('PRAGMA schema_version').get().schema_version,beforeSchema);assert.deepEqual(existing.state(),beforeRaw);assert.equal(fs.statSync(existing.dbPath).mode,mode);await new Promise(resolve=>existing.server.listen(0,'127.0.0.1',resolve));const secondBase=`http://127.0.0.1:${existing.server.address().port}${API}`,delegated=await(await fetch(secondBase+'health')).json();assert.equal(delegated.backup.mode,'delegated');assert.equal(delegated.backup.delegated,true);assert.equal(delegated.backup.lastSucceededAt,null);
  assert.equal(existing.authenticate(worker.token).name,workerProfile.name);const secondSession=existing.login({profile:qcProfile,pin:groupPin});assert.equal(service.authenticate(secondSession.token).name,qcProfile.name);
  const walBatch=existing.transact({id:randomUUID(),revision:existing.getRevision(),delta:imported(['WAL-A','WAL-B'])},adminProfile);assert.deepEqual(service.state(),existing.state());
  const walRevision=service.getRevision(),walBodies=walBatch.delta.tasks.map(task=>({id:randomUUID(),revision:walRevision,delta:{events:[event(task,'claim')]}}));
  const walResponses=await Promise.all([base,secondBase].map((url,i)=>fetch(url+'transactions',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Session':worker.token},body:JSON.stringify(walBodies[i])})));assert.deepEqual(walResponses.map(r=>r.status).sort(),[200,409]);const losingIndex=walResponses.findIndex(r=>r.status===409);for(const response of walResponses)await response.json();
  const losingService=losingIndex?existing:service;losingService.transact({...walBodies[losingIndex],revision:losingService.getRevision()},workerProfile);assert.equal(service.getRevision(),walRevision+2);assert.deepEqual(service.state(),existing.state());assert(walBatch.delta.tasks.every(task=>snapshot(service.state(),task.id).assignee===workerProfile.name));
  const beforeLiveBackup=service.getRevision(),liveCopy=path.join(directory,'live-wal-backup.sqlite'),liveBackup=service.onlineBackup(liveCopy);existing.transact({id:randomUUID(),revision:existing.getRevision(),delta:imported(['DURING-OWNER-BACKUP'])},adminProfile);const liveBackupResult=await liveBackup;assert([beforeLiveBackup,existing.getRevision()].includes(liveBackupResult.revision));
  const liveRestoreDir=path.join(directory,'live-wal-restore');fs.mkdirSync(liveRestoreDir);fs.copyFileSync(liveCopy,path.join(liveRestoreDir,'workbench.sqlite'));const liveRestored=createService({directory:liveRestoreDir,groupPin,adminPin});services.push(liveRestored);assert.equal(liveRestored.getRevision(),liveBackupResult.revision);assert.equal(liveRestored.exportBackup().transactions.length,liveBackupResult.revision);assert.equal(snapshot(liveRestored.state(),a.id).deleted,true);await liveRestored.close();services.splice(services.indexOf(liveRestored),1);
  await service.rollingBackup();const ownerHealth=await request('health'),stillDelegated=await(await fetch(secondBase+'health')).json();assert(ownerHealth.backup.lastSucceededAt);assert.equal(ownerHealth.backup.lastRevision,service.getRevision());assert.equal(stillDelegated.backup.mode,'delegated');assert.equal(stillDelegated.backup.lastSucceededAt,null);assert.equal(fs.readdirSync(path.join(directory,'backups')).length,1);full=service.exportBackup();
  proofs.push('Two live createService instances share WAL state and sessions: competing same-revision writes yield one conflict, retry preserves both independent task updates');
  proofs.push('The backup owner creates a consistent online snapshot while the delegated instance writes; only the owner runs rolling backup and the delegated health remains untouched');
  await existing.close();services.splice(services.indexOf(existing),1);
  const missing=path.join(directory,'must-not-exist');assert.throws(()=>createService({directory:missing,groupPin,adminPin,existingDatabaseOnly:true}),/Existing workbench database/);assert.equal(fs.existsSync(missing),false);
  proofs.push('Raw JSON/transaction backup remains complete for every client; online backup restores deletion state; existing-only startup performs no DDL/init/chmod/mkdir and advertises delegated backup');
  await service.close();services.splice(services.indexOf(service),1);service=createService({directory,groupPin,adminPin,existingDatabaseOnly:true,skipStartupBackup:true,backupIntervalMs:0,importDeleteGatePath:gate});services.push(service);assert.deepEqual(service.state(),full.state);assert.equal(service.authenticate(worker.token).name,workerProfile.name);assert.equal(snapshot(service.state(),a.id).deleted,true);
  proofs.push('Server restart retains old sessions, deletion audit history and active replacement tasks');
  assert.deepEqual(Object.fromEntries(sourceFiles().map(file=>[path.relative(path.resolve(__dirname,'..'),file).replaceAll('\\','/'),hash(file)])),sourceHashes);
  const result={ok:true,checkedAt:new Date().toISOString(),node:process.version,revision:service.getRevision(),checks:proofs,sharedWalConcurrency:true,backupDelegation:true,sourceHashes,oldClientHash:hash(oldFile),temporaryDirectory:directory,productionWrites:false};if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{for(const item of services.reverse())await item.close().catch(()=>{});});
