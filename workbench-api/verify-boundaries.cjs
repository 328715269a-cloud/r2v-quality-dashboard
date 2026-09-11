'use strict';
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createService}=require('./server.cjs');
const {snapshot,normalizeDelta}=require('./rules.cjs');
const uid=prefix=>`${prefix}_${randomUUID()}`;
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'r2v-workbench-boundaries-'));
const service=createService({directory,groupPin:'group-test',adminPin:'admin-test'});
const admin={name:'admin',role:'admin'};
const qc={name:'组长',role:'qc',groupId:'g01',mode:'single'};
const worker={name:'标注',role:'annotation',groupId:'g01',mode:'single'};
function seed(count){const batch={id:uid('batch'),groupId:'g01',mode:'single',date:'2026-09-10',movie:'批量影片',taskIds:[]};const tasks=Array.from({length:count},(_,i)=>({id:uid('task'),groupId:batch.groupId,mode:batch.mode,date:batch.date,movie:batch.movie,batchId:batch.id,tid:`BATCH_${i}`}));batch.taskIds=tasks.map(t=>t.id);return{tasks,batches:[batch],events:tasks.map(task=>({id:uid('event'),taskId:task.id,type:'dispatch'}))};}
function apply(delta,profile=admin,pin){return service.transact({id:randomUUID(),revision:service.getRevision(),delta,pin},profile);}
function fail(delta,profile=admin,pin){const before=service.exportBackup();assert.throws(()=>apply(delta,profile,pin));assert.deepEqual(service.exportBackup().state,before.state);assert.equal(service.getRevision(),before.revision);}
async function main(){
 const timings={};const data=seed(200);let start=performance.now();const result=apply(data);timings.import200Ms=performance.now()-start;
 const [task,second]=result.delta.tasks;
 fail({tasks:[{...task}]});fail({events:[{id:uid('event'),type:'sent_acceptance',taskId:task.id}]});fail({events:[{id:uid('event'),type:'submit',taskId:task.id}]},worker);
 fail({events:[{id:uid('event'),type:'claim',taskId:task.id,assignee:'其他人'}]},worker);
 const invalidDate=seed(1);invalidDate.tasks[0].date='2026-99-99';fail(invalidDate);
 const noBatch=seed(1);delete noBatch.batches;fail(noBatch);
 const noDispatch=seed(1);noDispatch.events=[];fail(noDispatch);
 const extraTask=seed(1);extraTask.batches[0].taskIds.push(task.id);fail(extraTask);
 const duplicateEvents={events:[{id:uid('event'),type:'claim',taskId:task.id},{id:uid('event'),type:'claim',taskId:second.id}]};duplicateEvents.events[1].id=duplicateEvents.events[0].id;fail(duplicateEvents,worker);
 fail({tasks:[],events:[],batches:[],preferences:{reset:true}});fail({events:[{id:uid('event'),type:'claim',taskId:task.id,identityAlias:true}]},worker);
 start=performance.now();const completed=apply({events:result.delta.tasks.flatMap(t=>[{id:uid('event'),taskId:t.id,type:'claim'},{id:uid('event'),taskId:t.id,type:'submit',round:1}])},worker);timings.complete200Ms=performance.now()-start;assert.equal(completed.delta.events.length,400);
 const handoff={id:uid('package'),kind:'handoff',groupId:'g01',mode:'single',date:'2026-09-10',movie:'批量影片',taskIds:result.delta.tasks.map(t=>t.id),stage:'qc',packageName:'通航质检包'};
 const packageEvents=result.delta.tasks.flatMap(t=>['package_built','package_claimed'].map(type=>({id:uid('event'),taskId:t.id,type,stage:'qc',packageId:handoff.id,packageRound:1})));
 fail({batches:[handoff],events:packageEvents.map(e=>({...e,packageId:uid('package')}))},qc);
 start=performance.now();apply({batches:[handoff],events:packageEvents},qc);timings.build200Ms=performance.now()-start;
 fail({events:[{id:uid('event'),taskId:task.id,type:'qc_fail',pLevel:'P1',tags:['注入标签'],note:'错误'}]},qc);
 fail({events:[{id:uid('event'),taskId:task.id,type:'qc_fail',pLevel:'P1',tags:['其他','其他'],note:'错误'}]},qc);
 start=performance.now();apply({events:result.delta.tasks.map(t=>({id:uid('event'),taskId:t.id,type:'qc_pass'}))},qc);timings.review200Ms=performance.now()-start;
 // All current TIDs are checked after the whole transaction, allowing a valid
 // two-way correction without changing the raw imported record or task owner.
 const edits=[{id:uid('event'),taskId:task.id,type:'metadata_edit',before:{tid:task.tid,movie:task.movie},after:{tid:second.tid,movie:task.movie},note:'互换更正'},{id:uid('event'),taskId:second.id,type:'metadata_edit',before:{tid:second.tid,movie:second.movie},after:{tid:task.tid,movie:task.movie},note:'互换更正'}];apply({events:edits},qc,'admin-test');assert.equal(snapshot(service.state(),task.id).tid,second.tid);assert.equal(service.state().tasks.find(t=>t.id===task.id).tid,task.tid);
 const edit={id:uid('group_day'),taskId:'group:g01',type:'group_daily_edit',groupId:'g01',mode:'single',date:'2026-09-09',before:{leader:'待填写',total:null,headcount:null},after:{leader:'组长',total:200,headcount:null},note:'日登记'};apply({events:[edit]},qc,'group-test');const inherited={...edit,id:uid('group_day'),date:'2026-09-10',before:{leader:'组长',total:null,headcount:null},after:{leader:'代理',total:100,headcount:0.5}};apply({events:[inherited]},qc,'group-test');
 fail({events:[{...inherited,id:uid('group_day'),date:'2026-09-11',before:{leader:'组长',total:null,headcount:null}}]},qc,'group-test');
 fail({events:[{...inherited,id:uid('group_day'),date:'2026-09-11',before:{leader:'代理',total:null,headcount:null},after:{leader:'代理',total:100,headcount:0.3}}]},qc,'group-test');
 // Registration success does not clear privileged-role brute-force limits.
 for(let i=0;i<30;i++)assert.throws(()=>service.login({profile:qc,pin:'wrong'},'brute-ip'));
 service.login({profile:worker},'brute-ip');assert.throws(()=>service.login({profile:qc,pin:'group-test'},'brute-ip'),error=>error.code==='RATE_LIMITED');
 for(let i=0;i<30;i++)assert.throws(()=>service.login({profile:admin,pin:'wrong'},'admin-brute-ip'));
 service.login({profile:qc,pin:'group-test'},'admin-brute-ip');assert.throws(()=>service.login({profile:admin,pin:'admin-test'},'admin-brute-ip'),error=>error.code==='RATE_LIMITED');
 const final=service.state();assert.equal(final.tasks.length,200);assert.equal(final.events.length,1204);assert(final.events.every(e=>e.actor&&e.actorRole&&e.at));
 const large=seed(2000);start=performance.now();const normalized=normalizeDelta({tasks:[],events:[],batches:[]},large,admin,{now:new Date().toISOString(),checkPin:()=>{}});timings.validate2000Ms=performance.now()-start;assert.equal(normalized.tasks.length,2000);
 const report={ok:true,checkedAt:new Date().toISOString(),timings,revision:service.getRevision(),tasks:final.tasks.length,events:final.events.length,checks:['缺批次/缺导入事件/重复ID/旧身份/无效日期/跳步状态整批拒绝','200条导入、完成、建包、质检及2000条校验性能','建包关联/非法和重复质检标签拒绝','原始TID保留及事务内双向更正','负责人跨日继承、日期设置冲突、半人精度','标注登记不能重置敏感角色密码尝试限制']};await service.close();if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
main().catch(async error=>{console.error(error);await service.close();process.exitCode=1;});
