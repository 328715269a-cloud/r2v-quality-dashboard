'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const {createService,API}=require('./server.cjs');
const {snapshot}=require('./rules.cjs');

const clone=value=>JSON.parse(JSON.stringify(value));
const event=(task,type,extra={})=>({id:randomUUID(),taskId:task.id,type,...extra});
function imported(count,movie){
  const batch={id:randomUUID(),groupId:'g01',mode:'single',movie,date:'2031-01-02',taskIds:[]};
  const tasks=Array.from({length:count},()=>({id:randomUUID(),tid:`FIXTURE_${randomUUID()}`,batchId:batch.id,groupId:batch.groupId,mode:batch.mode,movie,date:batch.date}));
  batch.taskIds=tasks.map(task=>task.id);return{tasks,batches:[batch],events:tasks.map(task=>event(task,'dispatch'))};
}
function merge(...values){return Object.fromEntries(['tasks','events','batches'].map(kind=>[kind,values.flatMap(value=>value[kind]||[])]));}
function packaged(tasks){
  const first=tasks[0],batch={id:randomUUID(),kind:'handoff',stage:'qc',packageName:'隔离验证包',date:first.date,groupId:first.groupId,mode:first.mode,movie:first.movie,taskIds:tasks.map(task=>task.id)};
  return{batches:[batch],events:tasks.flatMap(task=>['package_built','package_claimed'].map(type=>event(task,type,{stage:'qc',packageId:batch.id,packageName:batch.packageName,packageRound:1})))};
}

// Isolated fixture maintenance only. The production maintenance is a separate,
// reviewed operation; no real identifiers or credentials are stored here.
function cleanFixture(service,taskIds){
  const db=service.db,targets=new Set(taskIds),beforeRevision=service.getRevision();
  const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name IN ('immutable_records_delete','immutable_transactions_update')").all();
  assert.equal(triggers.length,2);
  const rows=db.prepare('SELECT * FROM records ORDER BY revision,ordinal').all();
  const removedBatches=new Set(rows.filter(row=>row.kind==='batches').map(row=>JSON.parse(row.json)).filter(batch=>batch.taskIds.some(id=>targets.has(id))).map(batch=>{assert(batch.taskIds.every(id=>targets.has(id)),'Fixture cleanup must not remove a mixed batch');return batch.id;}));
  const retired=JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='retiredTaskIds'").get()?.value||'[]');
  const removed=row=>row.kind==='tasks'?targets.has(row.id):row.kind==='events'?targets.has(JSON.parse(row.json).taskId):removedBatches.has(row.id);
  const preserved=rows.filter(row=>!removed(row));
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
    for(const row of rows.filter(removed))db.prepare('DELETE FROM records WHERE id=?').run(row.id);
    for(const transaction of db.prepare('SELECT id,result FROM transactions').all()){
      const result=JSON.parse(transaction.result),delta=result.delta;
      if(delta){delta.tasks=(delta.tasks||[]).filter(task=>!targets.has(task.id));delta.events=(delta.events||[]).filter(item=>!targets.has(item.taskId));delta.batches=(delta.batches||[]).filter(batch=>!removedBatches.has(batch.id));}
      db.prepare('UPDATE transactions SET result=? WHERE id=?').run(JSON.stringify(result),transaction.id);
    }
    const put=db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    put.run('revision',String(beforeRevision+1));put.run('fullSnapshotRevision',String(beforeRevision+1));put.run('retiredTaskIds',JSON.stringify([...new Set([...retired,...taskIds])]));
    for(const trigger of triggers)db.exec(trigger.sql);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  assert.deepEqual(db.prepare('SELECT * FROM records ORDER BY revision,ordinal').all(),preserved);
  return{revision:beforeRevision+1,removedBatches,preserved};
}

async function main(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-maintenance-'));
  const groupPin=randomUUID(),adminPin=randomUUID(),options={directory,groupPin,adminPin,skipStartupBackup:true,backupIntervalMs:0,importDeleteEnabled:true};
  const services=[];
  async function start(extra={}){const service=createService({...options,...extra});services.push(service);await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));return{service,origin:`http://127.0.0.1:${service.server.address().port}`};}
  try{
    const first=await start(),second=await start({existingDatabaseOnly:true});
    const request=async(server,endpoint,{session,body,method=body?'POST':'GET',status=200,modern=true}={})=>{
      const response=await fetch(server.origin+API+endpoint,{method,headers:{...(session?{'X-Workbench-Session':session.token}:{}),...(body?{'Content-Type':'application/json'}:{}),...(modern?{'X-Workbench-Client':'import-delete-v1'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;
    };
    const login=(profile,pin)=>request(first,'session',{body:{profile,pin}});
    const admin=await login({name:'admin',role:'admin'},adminPin),annotation=await login({name:'测试标注',role:'annotation',groupId:'g01',mode:'single'}),qc=await login({name:'测试质检',role:'qc',groupId:'g01',mode:'single'},groupPin);
    assert.equal(first.service.db.prepare("SELECT COUNT(*) AS count FROM metadata WHERE key IN ('fullSnapshotRevision','retiredTaskIds')").get().count,0,'Starting services must not write cleanup metadata');
    assert.deepEqual((await request(first,'state?after=0',{session:admin})).delta,{tasks:[],events:[],batches:[]});
    const tx=async(session,delta,extra={})=>{const body={id:randomUUID(),revision:first.service.getRevision(),delta,...extra};return{body,result:await request(first,'transactions',{session,body})};};
    const removedImport=imported(3,'隔离待清理影片'),keptImport=imported(2,'隔离保留影片'),targets=removedImport.tasks,kept=keptImport.tasks;
    const originalImport=await tx(admin,merge(removedImport,keptImport));
    await tx(annotation,{events:[...targets,kept[0]].flatMap(task=>[event(task,'claim'),event(task,'submit')])});
    await tx(qc,merge(packaged(targets),packaged([kept[0]])));
    const settings={id:randomUUID(),taskId:'group:g01',type:'group_daily_edit',groupId:'g01',mode:'single',date:'2031-01-02',before:{leader:'待填写',total:null,headcount:null},after:{leader:'测试组长',total:17,headcount:0.5},note:'隔离保留设置'};
    await tx(qc,{events:[settings]},{pin:groupPin});
    const softImport=imported(1,'隔离普通删除影片');await tx(admin,softImport);
    const softTask=softImport.tasks[0],softSnapshot=snapshot(first.service.state(),softTask.id);
    await tx(admin,{events:[event(softTask,'task_deleted',{batchId:softTask.batchId,expectedUpdatedAt:softSnapshot.updatedAt,note:'隔离验证普通删除'})]},{pin:adminPin});
    const sessionsBefore=first.service.db.prepare('SELECT * FROM sessions ORDER BY token_hash').all();
    const transactionIdentityBefore=first.service.db.prepare('SELECT id,revision,payload_hash,profile,created_at FROM transactions ORDER BY revision').all();
    const settingsBefore=first.service.state().events.find(item=>item.id===settings.id);
    const targetIds=new Set(targets.map(task=>task.id)),source=fs.readFileSync(path.join(__dirname,'../group-workbench/shared-store.js'),'utf8');
    let cleanup=null,lostResponseBody=null,originalResult=null,intercept=false;
    const transactionBodies=[];
    async function client(server,session,loseResponse=false){
      const storage=new Map([['r2v-group-workbench-shared-v1:session',JSON.stringify({token:session.token,profile:session.profile})]]),window={};
      const context={window,AbortSignal,crypto:{randomUUID},sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},fetch:async(url,options)=>{
        const response=await fetch(new URL(url,server.origin),options);
        if(loseResponse&&String(url).endsWith('/transactions')){
          transactionBodies.push(options.body);
          if(intercept&&response.ok){intercept=false;lostResponseBody=JSON.parse(options.body);originalResult=await response.clone().json();cleanup=cleanFixture(first.service,[...targetIds]);throw new Error('Isolated simulated lost response after maintenance');}
        }
        return response;
      }};
      vm.runInNewContext(source,context,{filename:'shared-store.js'});const store=window.WorkbenchStore.create();await store.init();return{store,storage};
    }
    const adminClient=await client(second,admin),qcClient=await client(first,qc,true);
    const cachedRevision=adminClient.store.revision();assert(targets.every(task=>adminClient.store.read().tasks.some(row=>row.id===task.id)));
    const settingsCached=clone(qcClient.store.read().events.find(item=>item.id===settings.id));
    intercept=true;
    await qcClient.store.transact(()=>({events:[...targets,kept[0]].map(task=>event(task,'qc_pass'))}));
    assert(cleanup);assert.equal(transactionBodies.length,2);assert.equal(transactionBodies[0],transactionBodies[1],'Transport retry must keep the same id and payload');
    const cleanState=first.service.state();
    const assertNoGhosts=state=>{assert(state.tasks.every(task=>!targetIds.has(task.id)));assert(state.events.every(item=>!targetIds.has(item.taskId)));assert(state.batches.every(batch=>!batch.taskIds.some(id=>targetIds.has(id))));};
    assertNoGhosts(cleanState);assertNoGhosts(qcClient.store.read());assert.equal(qcClient.store.revision(),cleanup.revision);
    for(const server of [first,second]){
      const full=await request(server,`state?after=${cachedRevision}`,{session:admin});assert(full.state);assert(!full.delta);assert.equal(full.revision,cleanup.revision);assertNoGhosts(full.state);
      const delta=await request(server,`state?after=${cleanup.revision}`,{session:admin});assert.deepEqual(delta.delta,{tasks:[],events:[],batches:[]});
      const legacy=await request(server,`state?after=${cachedRevision}`,{session:annotation,modern:false});assert(legacy.state);assertNoGhosts(legacy.state);assert(!legacy.state.tasks.some(task=>task.id===softTask.id),'Legacy task_deleted filtering must remain');
    }
    await adminClient.store.refresh();assertNoGhosts(adminClient.store.read());assert.equal(adminClient.store.revision(),cleanup.revision);assert.equal(adminClient.store.profile().name,'admin');assert.equal(qcClient.store.profile().name,qc.profile.name);
    assert.deepEqual(clone(qcClient.store.read().events.find(item=>item.id===settings.id)),settingsCached);assert.deepEqual(cleanState.events.find(item=>item.id===settings.id),settingsBefore);
    assert.deepEqual(first.service.db.prepare('SELECT * FROM sessions ORDER BY token_hash').all(),sessionsBefore);
    assert.deepEqual(first.service.db.prepare('SELECT id,revision,payload_hash,profile,created_at FROM transactions WHERE revision<=? ORDER BY revision').all(cachedRevision),transactionIdentityBefore);
    const replay=await request(second,'transactions',{session:qc,body:lostResponseBody});assert.equal(replay.revision,originalResult.revision);assert.equal(replay.delta.events.length,1);assert.equal(replay.delta.events[0].taskId,kept[0].id);assert.equal(first.service.getRevision(),cleanup.revision);
    const importReplay=await request(first,'transactions',{session:admin,body:originalImport.body});assert.equal(importReplay.revision,originalImport.result.revision);assert.deepEqual(importReplay.delta.tasks.map(task=>task.id),kept.map(task=>task.id));assertNoGhosts(importReplay.delta);
    await request(first,'transactions',{session:admin,body:{...originalImport.body,delta:{events:[]}},status:409}).then(result=>assert.equal(result.error.code,'IDEMPOTENCY_MISMATCH'));
    const cleanBefore=JSON.stringify(first.service.state()),revisionBefore=first.service.getRevision();
    const newImport=imported(1,'隔离复用记录编号');newImport.tasks[0].id=targets[0].id;newImport.batches[0].taskIds=[targets[0].id];newImport.events[0].taskId=targets[0].id;
    const invalidDeltas=[{session:admin,delta:newImport},{session:annotation,delta:{events:[event(kept[1],'claim'),event(targets[1],'claim')]}},{session:qc,delta:{batches:[{...packaged([kept[1]]).batches[0],taskIds:[kept[1].id,targets[2].id]}]}}];
    for(const [index,invalid]of invalidDeltas.entries()){
      const result=await request(index%2?second:first,'transactions',{session:invalid.session,body:{id:randomUUID(),revision:index===0?cachedRevision:revisionBefore,delta:invalid.delta},status:409});assert.equal(result.error.code,'TASK_REMOVED');assert.match(result.error.message,/未保存/);assert.equal(first.service.getRevision(),revisionBefore);assert.equal(JSON.stringify(first.service.state()),cleanBefore);
    }
    assert.equal(snapshot(first.service.state(),kept[1].id).status,'unclaimed','Mixed rejected transaction must not claim unrelated task');
    const freshImport=imported(1,'隔离后续正常影片');await tx(admin,freshImport);const freshTask=freshImport.tasks[0];
    await tx(annotation,{events:[event(kept[1],'claim'),event(freshTask,'claim'),event(freshTask,'submit')]});await tx(qc,packaged([freshTask]));await tx(qc,{events:[event(freshTask,'qc_pass')]});
    assert.equal(snapshot(first.service.state(),freshTask.id).status,'pending_acceptance');assert.equal(snapshot(first.service.state(),kept[1].id).status,'annotating');assertNoGhosts(first.service.state());
    const third=await start({existingDatabaseOnly:true});const persisted=await request(third,`state?after=${cachedRevision}`,{session:admin});assert(persisted.state);assertNoGhosts(persisted.state);assert.deepEqual((await request(third,'session',{session:qc})).profile,qc.profile);
    assert.deepEqual(first.service.db.prepare('SELECT * FROM sessions ORDER BY token_hash').all(),sessionsBefore);
    assert.deepEqual(first.service.state().events.find(item=>item.id===settings.id),settingsBefore);
    assert.throws(()=>first.service.db.prepare('DELETE FROM records WHERE id=?').run(kept[0].id),/append only/);
    assert.throws(()=>first.service.db.prepare('UPDATE transactions SET result=result WHERE id=?').run(originalImport.body.id),/append only/);
    assert.equal(first.service.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    console.log(JSON.stringify({ok:true,checks:['metadata absent keeps delta protocol and does not write on startup','three retired tasks and all related histories vanish from full replacement','already-running shared WAL services observe maintenance immediately','real shared-store lost-response retry uses clipped idempotent result then full refresh','historical request replay retains revision/hash/profile and cannot revive removed records','new task/event/batch references reject the whole transaction with TASK_REMOVED','normal imports and work continue; unrelated tasks and group_daily settings are retained','sessions persist without re-login; legacy filtering, append-only triggers and SQLite integrity remain valid'],retiredTaskCount:targets.length},null,2));
  }finally{for(const service of services.reverse())await service.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
