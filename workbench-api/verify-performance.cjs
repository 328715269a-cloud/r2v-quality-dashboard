'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {fork}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {createService,API}=require('./server.cjs');
const {snapshot}=require('./rules.cjs');
const groupPin='isolated-performance-group',adminPin='isolated-performance-admin';
const admin={name:'admin',role:'admin'};
const profile=(role,groupId='g01',name=role==='annotation'?'测试标注':'测试质检')=>({name,role,groupId,mode:groupId==='g06'?'multi':'single'});
const event=(task,type,extra={})=>({id:randomUUID(),taskId:task.id,type,...extra});
function imported(tids,groupId='g01'){
  const batch={id:randomUUID(),date:'2031-01-02',groupId,mode:groupId==='g06'?'multi':'single',movie:'隔离性能影片'};
  const tasks=tids.map(tid=>({id:randomUUID(),tid,batchId:batch.id,date:batch.date,groupId,mode:batch.mode,movie:batch.movie}));
  batch.taskIds=tasks.map(task=>task.id);return{tasks,batches:[batch],events:tasks.map(task=>event(task,'dispatch'))};
}
async function listen(service){await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${service.server.address().port}${API}`;}
async function request(base,endpoint,{token,body,status=200,modern=true}={}){
  const response=await fetch(base+endpoint,{method:body?'POST':'GET',headers:{...(token?{'X-Workbench-Session':token}:{}),...(body?{'Content-Type':'application/json'}:{}),...(modern?{'X-Workbench-Client':'import-delete-v1'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;
}
function tx(service,who,delta,extras={}){return service.transact({id:randomUUID(),revision:service.getRevision(),delta,...extras},who);}
function fail(service,who,delta,code,extras={}){
  const before=JSON.stringify(service.state()),revision=service.getRevision();
  assert.throws(()=>tx(service,who,delta,extras),error=>error.code===code,code);
  assert.equal(service.getRevision(),revision);assert.equal(JSON.stringify(service.state()),before,'Rejected transaction must be fully atomic');
}

// This destructive fixture utility is reachable only in temporary test DBs.
function cleanFixture(service,task){
  const db=service.db,rows=db.prepare('SELECT id,kind,json FROM records').all(),remove=new Set(rows.filter(row=>row.id===task.id||row.id===task.batchId||row.kind==='events'&&JSON.parse(row.json).taskId===task.id).map(row=>row.id));
  const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN ('immutable_records_delete','immutable_transactions_update')").all();
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
    for(const id of remove)db.prepare('DELETE FROM records WHERE id=?').run(id);
    for(const row of db.prepare('SELECT id,result FROM transactions').all()){
      const value=JSON.parse(row.result);for(const kind of ['tasks','events','batches'])value.delta[kind]=value.delta[kind].filter(record=>!remove.has(record.id));
      db.prepare('UPDATE transactions SET result=? WHERE id=?').run(JSON.stringify(value),row.id);
    }
    const put=db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),revision=service.getRevision()+1;
    put.run('revision',String(revision));put.run('fullSnapshotRevision',String(revision));put.run('retiredTaskIds',JSON.stringify([task.id]));
    for(const trigger of triggers)db.exec(trigger.sql);db.exec('COMMIT');return revision;
  }catch(error){db.exec('ROLLBACK');throw error;}
}

async function child(){
  // The original full-state validation path models a retained old API process.
  const service=createService({directory:process.argv[3],groupPin,adminPin,existingDatabaseOnly:true,skipStartupBackup:true,backupIntervalMs:0,relatedValidation:false,importDeleteEnabled:true});
  process.send({base:await listen(service)});
  process.on('message',async message=>{if(message==='close'){await service.close();process.exit(0);}});
}

async function regression(directory){
  const service=createService({directory,groupPin,adminPin,skipStartupBackup:true,backupIntervalMs:0,importDeleteEnabled:true}),base=await listen(service);
  let worker;
  try{
    const adminSession=service.login({profile:admin,pin:adminPin}),annotation=profile('annotation'),qc=profile('qc'),acceptance=profile('acceptance');
    const annotationSession=service.login({profile:annotation}),qcSession=service.login({profile:qc,pin:groupPin}),acceptanceSession=service.login({profile:acceptance,pin:groupPin});
    const one=imported(['PERF-A','PERF-B','PERF-C','PERF-D']),two=imported(['OTHER-A'],'g02'),multi=imported(['MULTI-A'],'g06'),removed=imported(['REMOVED-A']),deleted=imported(['DELETED-A']);
    for(const delta of [one,two,multi,removed,deleted])tx(service,admin,delta);
    const [a,b,c,d]=one.tasks;
    const firstScope=await request(base,'state?scope=role-v1',{token:qcSession.token});
    assert(firstScope.state.tasks.every(task=>task.groupId==='g01'));
    assert.equal(firstScope.state.tasks.length,6);assert.equal((await request(base,'state',{token:qcSession.token})).state.tasks.length,8);
    assert.deepEqual(await request(base,'state?scope=role-v1',{token:acceptanceSession.token}),await request(base,'state',{token:acceptanceSession.token}));
    assert.deepEqual(await request(base,'state?scope=role-v1',{token:adminSession.token}),await request(base,'state',{token:adminSession.token}));
    worker=fork(__filename,['child',directory],{stdio:['ignore','ignore','inherit','ipc']});
    const oldBase=await new Promise((resolve,reject)=>{worker.once('message',message=>resolve(message.base));worker.once('error',reject);worker.once('exit',code=>reject(new Error(`Child exited before listening: ${code}`)));});
    async function oldTx(who,delta,extras={}){return request(oldBase,'transactions',{token:who.token,body:{id:randomUUID(),revision:service.getRevision(),delta,...extras}});}
    await oldTx(annotationSession,{events:[a,b,c].flatMap(task=>[event(task,'claim'),event(task,'submit')])});
    const beforeCatchup=service.performanceStats();
    const saved=tx(service,qc,{events:[event(a,'qc_pass')]});
    assert.equal(snapshot(service.state(),a.id).status,'pending_acceptance');
    const afterCatchup=service.performanceStats();assert.equal(afterCatchup.recordsRead-beforeCatchup.recordsRead,6);assert.equal(afterCatchup.relatedTasks-beforeCatchup.relatedTasks,1);assert.equal(afterCatchup.relatedEvents-beforeCatchup.relatedEvents,3);
    const stale={id:randomUUID(),revision:saved.revision,delta:{events:[event(b,'qc_pass')]}};
    await oldTx(annotationSession,{events:[event(d,'claim')]});
    assert.throws(()=>service.transact(stale,qc),error=>error.code==='REVISION_CONFLICT');
    fail(service,qc,{events:[event(b,'qc_pass'),event(a,'qc_pass')]},'STATE_CONFLICT');
    assert.equal(snapshot(service.state(),b.id).status,'pending_qc');
    fail(service,qc,{events:[event(b,'qc_pass',{id:two.events[0].id})]},'DUPLICATE_ID');
    fail(service,profile('qc','g02'),{events:[event(b,'qc_pass')]},'FORBIDDEN');
    const body={id:randomUUID(),revision:service.getRevision(),delta:{events:[event(b,'qc_pass')]}};
    const original=service.transact(body,qc);assert.deepEqual(service.transact(body,qc),original);
    assert.throws(()=>service.transact({...body,delta:{events:[event(c,'qc_pass')]}},qc),error=>error.code==='IDEMPOTENCY_MISMATCH');
    // An old process and new process race at one global revision: exactly one wins.
    const revision=service.getRevision(),race=await Promise.all([request(base,'transactions',{token:qcSession.token,body:{id:randomUUID(),revision,delta:{events:[event(c,'qc_pass')]}}}).then(()=>200,error=>{assert.match(error.message,/409/);return 409;}),request(oldBase,'transactions',{token:qcSession.token,body:{id:randomUUID(),revision,delta:{events:[event(c,'qc_pass')]}}}).then(()=>200,error=>{assert.match(error.message,/409/);return 409;})]);
    assert.deepEqual(race.sort(),[200,409]);
    const fallbackBefore=service.performanceStats().relatedTransactions;
    fail(service,admin,imported(['other-a'],'g06'),'DUPLICATE_TID');
    const current=snapshot(service.state(),d.id),edit=event(d,'metadata_edit',{before:{tid:current.tid,movie:current.movie},after:{tid:'OTHER-A',movie:current.movie},note:'隔离更正'});
    fail(service,qc,{events:[edit]},'DUPLICATE_TID',{pin:adminPin});
    tx(service,qc,{events:[{...edit,id:randomUUID(),after:{tid:'RENAMED-D',movie:current.movie}}]},{pin:adminPin});
    const daily={id:randomUUID(),taskId:'group:g02',type:'group_daily_edit',groupId:'g02',mode:'single',date:'2031-01-02',before:{leader:'待填写',total:null,headcount:null},after:{leader:'测试组长',total:3,headcount:1},note:'隔离设置'};
    tx(service,profile('qc','g02'),{events:[daily]},{pin:groupPin});
    const deletedTask=deleted.tasks[0];tx(service,admin,{events:[event(deletedTask,'task_deleted',{batchId:deletedTask.batchId,expectedUpdatedAt:snapshot(service.state(),deletedTask.id).updatedAt,note:'隔离整批删除'})]},{pin:adminPin});
    assert.equal(service.performanceStats().relatedTransactions,fallbackBefore,'Management actions must stay on full validation');
    tx(service,annotation,{events:[event(d,'submit')]});
    assert.equal(service.state().events.at(-1).tidAtEvent,'RENAMED-D','Catchup must apply metadata edits before validating normal work');
    const modern=await request(base,'state?scope=role-v1',{token:qcSession.token}),legacy=await request(base,'state?scope=role-v1',{token:qcSession.token,modern:false});
    assert(modern.state.tasks.some(task=>task.id===deletedTask.id));assert(!legacy.state.tasks.some(task=>task.id===deletedTask.id));
    const noChangeRevision=service.getRevision();tx(service,profile('annotation','g02'),{events:[event(two.tasks[0],'claim')]});
    const beforeEmpty=service.performanceStats().scopedRecordsRead;
    const empty=await request(base,`state?scope=role-v1&after=${noChangeRevision}`,{token:qcSession.token});assert.equal(empty.revision,service.getRevision());assert.deepEqual(empty.delta,{tasks:[],events:[],batches:[]});assert.equal(service.performanceStats().scopedRecordsRead,beforeEmpty,'Empty scoped increments must not scan historical rows');
    const groupTwoSession=service.login({profile:profile('qc','g02'),pin:groupPin}),groupTwo=await request(base,'state?scope=role-v1',{token:groupTwoSession.token});assert.deepEqual(groupTwo.state.tasks.map(task=>task.id),[two.tasks[0].id]);assert(groupTwo.state.events.some(row=>row.id===daily.id));
    const beforeBarrier=service.performanceStats(),sessionsBefore=service.db.prepare('SELECT * FROM sessions ORDER BY token_hash').all(),barrier=cleanFixture(service,removed.tasks[0]);
    const afterBarrier=await request(base,`state?scope=role-v1&after=${noChangeRevision}`,{token:qcSession.token});assert(afterBarrier.state);assert.equal(afterBarrier.revision,barrier);assert(!afterBarrier.state.tasks.some(task=>task.id===removed.tasks[0].id));assert.equal(service.performanceStats().rebuilds,beforeBarrier.rebuilds+1);
    fail(service,annotation,{events:[event(removed.tasks[0],'claim')]},'TASK_REMOVED');
    tx(service,qc,{events:[event(d,'qc_pass')]});
    assert.equal(snapshot(service.state(),d.id).status,'pending_acceptance');
    // Preserve all direct/rework transitions and the historical acceptance
    // package compatibility branch while running normal writes on small states.
    tx(service,acceptance,{events:[event(a,'acceptance_fail',{note:'隔离验收退回',acceptanceRound:1})]});
    tx(service,qc,{events:[event(a,'acceptance_route',{route:'qc',note:'质检自行修改'})]});
    tx(service,qc,{events:[event(a,'qc_repair_done',{note:'已修改'})]});
    tx(service,acceptance,{events:[event(a,'acceptance_pass',{acceptanceRound:2})]});
    assert.equal(snapshot(service.state(),a.id).status,'accepted');
    tx(service,acceptance,{events:[event(b,'acceptance_fail',{note:'需要标注返修'})]});
    tx(service,qc,{events:[event(b,'acceptance_route',{route:'annotation',note:'标注修改'})]});
    tx(service,qc,{events:[event(b,'claim',{assignmentKind:'rework_transfer',fromAssignee:annotation.name,assignee:'测试代修',assignmentStatus:'acceptance_rework',note:'隔离代修'})]});
    fail(service,annotation,{events:[event(b,'submit')]},'STATE_CONFLICT');
    tx(service,profile('annotation','g01','测试代修'),{events:[event(b,'submit',{round:2})]});
    tx(service,qc,{events:[event(b,'qc_pass',{round:2,qcRound:2})]});
    const currentB=snapshot(service.state(),b.id),pack={id:randomUUID(),kind:'handoff',stage:'acceptance',packageName:'隔离历史验收包',taskIds:[b.id],date:b.date,groupId:b.groupId,mode:b.mode,movie:b.movie};
    const beforePackage=service.performanceStats().relatedTransactions;
    tx(service,qc,{batches:[pack],events:['package_built','package_claimed'].map(type=>event(b,type,{stage:'acceptance',packageId:pack.id,packageRound:currentB.acceptanceRound}))});
    assert.equal(service.performanceStats().relatedTransactions,beforePackage);
    tx(service,acceptance,{events:[event(b,'acceptance_pass',{acceptanceRound:currentB.acceptanceRound})]});
    assert.equal(snapshot(service.state(),b.id).status,'accepted');
    fail(service,qc,{events:[event(d,'admin_reassign',{assignee:'测试代修',toRole:'annotation',note:'隔离改派'})]},'PIN_INVALID');
    tx(service,qc,{events:[event(d,'admin_reassign',{assignee:'测试代修',toRole:'annotation',note:'隔离改派'})]},{pin:adminPin});
    tx(service,profile('annotation','g01','测试代修'),{events:[event(d,'annotator_reject',{note:'隔离拒绝申请'})]});
    tx(service,qc,{events:[event(d,'reject_return',{note:'继续处理'})]});
    tx(service,profile('annotation','g01','测试代修'),{events:[event(d,'annotator_reject',{note:'隔离再次拒绝'})]});
    tx(service,qc,{events:[event(d,'reject_confirm',{note:'确认拒绝'})]});
    assert.equal(snapshot(service.state(),d.id).status,'rejected');
    assert.deepEqual(service.db.prepare('SELECT * FROM sessions ORDER BY token_hash').all(),sessionsBefore);
    assert.equal(service.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    return{crossProcessAppendCatchup:true,globalRevisionRace:true,idempotency:true,batchAtomicity:true,globalIdCollision:true,globalTidAndManagementFallback:true,roleScope:true,emptyCrossGroupDelta:true,fullSnapshotBarrier:true,oldSessionsAndDeletedTaskCompatibility:true,directAcceptanceAndRework:true,legacyAcceptancePackage:true,reassignmentAndRejection:true,stats:service.performanceStats()};
  }finally{
    if(worker&&worker.exitCode===null){const exited=new Promise(resolve=>worker.once('exit',resolve));worker.send('close');await exited;}
    await service.close();
  }
}

function seedBenchmark(service,count){
  const db=service.db,insert=db.prepare('INSERT INTO records(id,kind,revision,ordinal,json) VALUES(?,?,?,?,?)');
  let ordinal=0;const tasks=[];db.exec('BEGIN IMMEDIATE');
  try{
    for(let i=0;i<count;i++){
      const task={id:randomUUID(),tid:`SCALE_${i}`,date:'2031-01-02',groupId:i%2?'g02':'g01',mode:'single',movie:'合成规模影片',batchId:randomUUID(),createdAt:'2031-01-02T00:00:00.000Z',createdBy:'admin'};tasks.push(task);
      insert.run(task.id,'tasks',1,ordinal++,JSON.stringify(task));
      const types=['dispatch','claim','submit','qc_fail','submit'];
      for(let n=0;n<types.length;n++){
        const value=event(task,types[n],{workflowVersion:3,at:`2031-01-02T00:00:0${n+1}.000Z`,actor:types[n]==='qc_fail'?'测试质检':'测试标注',actorRole:types[n]==='qc_fail'?'qc':'annotation',...(types[n]==='claim'?{assignee:'测试标注'}:{}),...(types[n]==='qc_fail'?{round:1,qcRound:1,pLevel:'P1',tags:['主体/对象漏标'],note:'合成返修'}:{})});
        insert.run(value.id,'events',1,ordinal++,JSON.stringify(value));
      }
    }
    db.prepare("UPDATE metadata SET value='1' WHERE key='revision'").run();db.exec('COMMIT');return tasks;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
async function benchmark(directory,count){
  const options={directory,groupPin,adminPin,skipStartupBackup:true,backupIntervalMs:0};
  const seed=createService(options);const tasks=seedBenchmark(seed,count);await seed.close();
  const start=performance.now(),optimized=createService({...options,existingDatabaseOnly:true}),warmMs=performance.now()-start,baseline=createService({...options,existingDatabaseOnly:true,relatedValidation:false});
  try{
    const fast=[],full=[],before=optimized.performanceStats();
    for(let i=0;i<8;i++){
      let begin=performance.now();tx(optimized,profile('qc'),{events:[event(tasks[i*4],'qc_pass')]});fast.push(performance.now()-begin);
      begin=performance.now();tx(baseline,profile('qc'),{events:[event(tasks[i*4+2],'qc_pass')]});full.push(performance.now()-begin);
    }
    const after=optimized.performanceStats(),median=values=>values.slice().sort((a,b)=>a-b)[Math.floor(values.length/2)];
    assert.equal(after.relatedTasks-before.relatedTasks,8);assert.equal(after.relatedEvents-before.relatedEvents,40);assert(after.recordsRead-before.recordsRead<=14,'Steady writes must only catch up newly appended records');assert.equal(after.rebuilds,before.rebuilds);
    return{tasks:count,initialEvents:count*5,warmMs:Number(warmMs.toFixed(2)),samples:8,optimizedMedianMs:Number(median(fast).toFixed(2)),fullValidationMedianMs:Number(median(full).toFixed(2)),relatedTasksRead:after.relatedTasks-before.relatedTasks,relatedHistoryEventsRead:after.relatedEvents-before.relatedEvents,tailRecordsRead:after.recordsRead-before.recordsRead};
  }finally{await baseline.close();await optimized.close();}
}
async function duplicateInvariant(directory){
  const service=createService({directory,groupPin,adminPin,skipStartupBackup:true,backupIntervalMs:0});
  try{
    const one=imported(['INVARIANT-A']),two=imported(['INVARIANT-B'],'g02');tx(service,admin,one);tx(service,admin,two);
    // Simulate an externally introduced historic duplicate. Ordinary writes must
    // retain the former global validator's rejection rather than hide corruption.
    const task=two.tasks[0],revision=service.getRevision()+1,value=event(task,'metadata_edit',{workflowVersion:3,at:'2031-01-02T00:00:01.000Z',actor:'admin',actorRole:'admin',before:{tid:task.tid,movie:task.movie},after:{tid:one.tasks[0].tid,movie:task.movie},note:'合成历史异常'});
    service.db.exec('BEGIN IMMEDIATE');service.db.prepare('INSERT INTO records(id,kind,revision,ordinal,json) VALUES(?,?,?,?,?)').run(value.id,'events',revision,0,JSON.stringify(value));service.db.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(String(revision));service.db.exec('COMMIT');
    fail(service,profile('annotation'),{events:[event(one.tasks[0],'claim')]},'DUPLICATE_TID');
    assert.equal(service.performanceStats().relatedTransactions,0);
    tx(service,admin,{events:[event(task,'metadata_edit',{before:value.after,after:{tid:task.tid,movie:task.movie},note:'修复合成异常'})]},{pin:adminPin});
    tx(service,profile('annotation'),{events:[event(one.tasks[0],'claim')]});assert.equal(service.performanceStats().relatedTransactions,1);
    return true;
  }finally{await service.close();}
}
async function main(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-performance-'));
  const checks=await regression(path.join(directory,'regression')),scale=[];checks.existingGlobalTidInvariant=await duplicateInvariant(path.join(directory,'duplicate-invariant'));
  if(!process.argv.includes('--regression-only'))for(const count of [1000,12000])scale.push(await benchmark(path.join(directory,`scale-${count}`),count));
  const result={ok:true,node:process.versions.node,checkedAt:new Date().toISOString(),checks,scale,temporaryDirectory:directory};
  if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}
if(process.argv[2]==='child')child().catch(error=>{console.error(error);process.exitCode=1;});else main().catch(error=>{console.error(error);process.exitCode=1;});
