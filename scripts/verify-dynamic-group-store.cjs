'use strict';
// Synthetic fetch/VM checks only. No network, filesystem business state or live sessions.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {randomUUID,createHash}=require('node:crypto');
const source=fs.readFileSync(path.resolve(__dirname,'../group-workbench/shared-store.js'),'utf8');
const base=[{id:'g01',name:'单镜头1组',defaultMode:'single'}];
const custom={id:'group_'+randomUUID(),name:'测试自定义组',defaultMode:'multi'};
const worker={name:'测试',role:'annotation',mode:'single',groupId:'g01'};
const admin={name:'admin',role:'admin'};
const empty=()=>({version:3,createdAt:'2026-10-30T00:00:00Z',tasks:[],events:[],batches:[],preferences:{}});
const copy=x=>JSON.parse(JSON.stringify(x));
const ok=body=>({ok:true,status:200,json:async()=>copy(body)});
const fail=(status,code='NOT_FOUND')=>({ok:false,status,json:async()=>({error:{code,message:'synthetic '+code}})});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function harness(profile=null){
  const memory=new Map(),calls=[],events=[];
  if(profile)memory.set('r2v-group-workbench-shared-v1:session',JSON.stringify({token:'synthetic-token',profile}));
  const fixture={profile:profile||admin,revision:0,groups:copy(base),state:empty(),routes:{},receipt:null,transactionAttempts:[]};
  const context={window:{},AbortSignal,crypto:{randomUUID},sessionStorage:{getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)},fetch:async(url,options)=>{
    assert(url.startsWith('/group-workbench-api/'));const part=url.slice('/group-workbench-api/'.length),key=part.split('?')[0];calls.push({part,options});
    if(fixture.routes[key])return fixture.routes[key](part,options);
    if(key==='groups')return ok({revision:fixture.revision,groups:fixture.groups});
    if(key==='session')return ok(options.method==='POST'?{token:'synthetic-login',profile:fixture.profile}:{profile:fixture.profile});
    if(key==='state')return ok({revision:fixture.revision,state:fixture.state,groups:fixture.groups});
    throw Error('Unexpected endpoint '+key);
  }};
  vm.runInNewContext(source,context,{filename:'shared-store.js'});
  const store=context.window.WorkbenchStore.create();store.subscribe(e=>events.push(e));
  return{store,fixture,memory,calls,events};
}
const checks=[];
async function run(label,test){await test();checks.push(label);}
(async()=>{
  await run('public catalog loads before identity/session restoration; no task/session creation',async()=>{
    const h=harness();h.fixture.groups.push(custom);await h.store.init();assert.equal(h.store.profile(),null);assert.equal(h.store.groups()[1].id,custom.id);assert.deepEqual(h.calls.map(x=>x.part),['groups']);assert.equal(h.store.read().tasks.length,0);
  });
  await run('catalog results are cloned and cannot be changed by callers',async()=>{
    const h=harness();await h.store.init();h.store.groups()[0].name='changed';assert.equal(h.store.groups()[0].name,base[0].name);
  });
  await run('directory outage preserves existing session and obtains catalog through state',async()=>{
    const h=harness(worker);h.fixture.routes.groups=()=>fail(503,'TEMPORARY');h.fixture.groups.push(custom);await h.store.init();assert.equal(h.store.profile().name,worker.name);assert.equal(h.store.groups().length,2);assert(h.memory.has('r2v-group-workbench-shared-v1:session'));
  });
  await run('legacy API without catalog endpoint/fields still restores existing session',async()=>{
    const h=harness(worker);h.fixture.routes.groups=()=>fail(404);h.fixture.routes.state=()=>ok({revision:0,state:h.fixture.state});await h.store.init();assert.equal(h.store.groups(),null);assert.equal(h.store.profile().groupId,'g01');assert.equal(h.store.revision(),0);
  });
  await run('same-revision empty task delta can refresh catalog and notify without replacing task state',async()=>{
    const h=harness(worker);await h.store.init();const before=h.store.read();h.fixture.routes.state=()=>ok({revision:0,delta:{tasks:[],events:[],batches:[]},groups:[...base,custom]});assert.equal(await h.store.refresh(),true);assert.equal(h.store.read(),before);assert.equal(h.store.groups().length,2);assert.equal(h.events.at(-1).changed,true);
  });
  await run('new revision containing no visible task records still publishes catalog change',async()=>{
    const h=harness(worker);await h.store.init();const before=h.store.read();h.fixture.routes.state=()=>ok({revision:1,delta:{tasks:[],events:[],batches:[]},groups:[...base,custom]});assert.equal(await h.store.refresh(),true);assert.equal(h.store.read(),before);assert.equal(h.store.revision(),1);assert.equal(h.store.groups().length,2);
  });
  await run('late older public catalog cannot overwrite newer state catalog',async()=>{
    const h=harness(worker);await h.store.init();const wait=deferred();h.fixture.routes.groups=()=>wait.promise;const pending=h.store.refreshGroups();h.fixture.revision=2;h.fixture.groups.push(custom);await h.store.refresh();wait.resolve(ok({revision:1,groups:base}));await pending;assert.equal(h.store.groups().length,2);assert.equal(h.store.revision(),2);
  });
  await run('public catalog refresh does not advance business revision or skip task updates',async()=>{
    const h=harness(worker);await h.store.init();h.fixture.revision=4;h.fixture.groups.push(custom);await h.store.refreshGroups();assert.equal(h.store.revision(),0);h.fixture.state.tasks.push({id:'task-local',groupId:'g01',mode:'single'});await h.store.refresh();assert.equal(h.store.revision(),4);assert.equal(h.store.read().tasks.length,1);assert(h.calls.at(-1).part.includes('after=0'));
  });
  await run('parallel catalog refreshes coalesce into one request',async()=>{
    const h=harness();await h.store.init();const wait=deferred();let reads=0;h.fixture.routes.groups=()=>{reads++;return wait.promise;};const a=h.store.refreshGroups(),b=h.store.refreshGroups();assert.equal(reads,1);wait.resolve(ok({revision:2,groups:[...base,custom]}));await Promise.all([a,b]);assert.equal(h.store.groups().length,2);
  });
  await run('invalid catalog leaves prior directory/task snapshot intact',async()=>{
    const h=harness(worker);await h.store.init();const prior=h.store.read();h.fixture.routes.groups=()=>ok({revision:2,groups:[base[0],base[0]]});await assert.rejects(h.store.refreshGroups(),/小组目录格式异常/);assert.equal(h.store.groups().length,1);assert.equal(h.store.read(),prior);assert.equal(h.store.profile().name,worker.name);
  });
  await run('malformed task delta cannot publish its newer valid catalog or advance business revision',async()=>{
    const h=harness(worker);h.fixture.state.tasks=[{id:'own',groupId:'g01',mode:'single',tid:'ORIGINAL'}];await h.store.init();const prior=h.store.read();h.fixture.routes.state=()=>ok({revision:1,delta:{tasks:[{id:'own',groupId:'g01',mode:'single',tid:'CHANGED'}],events:[],batches:[]},groups:[...base,custom]});await assert.rejects(h.store.refresh(),/共享历史记录存在冲突/);assert.equal(h.store.read(),prior);assert.equal(h.store.revision(),0);assert.equal(h.store.groups().length,1);assert.equal(h.store.read().tasks[0].tid,'ORIGINAL');
  });
  await run('role scoping retains own group records only while names directory is shared',async()=>{
    const h=harness(worker);h.fixture.groups.push(custom);h.fixture.state.tasks=[{id:'own',groupId:'g01',mode:'single'},{id:'other',groupId:custom.id,mode:'multi'}];h.fixture.state.events=[{id:'own-event',taskId:'own'},{id:'other-event',taskId:'other'},{id:'group-event',type:'group_created',taskId:'group:'+custom.id,groupId:custom.id,mode:'multi',name:custom.name}];h.fixture.state.batches=[{id:'mixed',taskIds:['own','other']}];await h.store.init();assert.deepEqual(copy(h.store.read().tasks).map(t=>t.id),['own']);assert.deepEqual(copy(h.store.read().events).map(t=>t.id),['own-event']);assert.deepEqual(copy(h.store.read().batches[0].taskIds),['own']);assert.equal(h.store.groups().length,2);
  });
  await run('lost response retry uses identical transaction id/body and creates exactly one group event',async()=>{
    const h=harness(admin);await h.store.init();const draft={name:'自定小组',mode:'multi'},snapshot=copy(draft),event={id:'event_'+randomUUID(),taskId:'group:'+custom.id,type:'group_created',groupId:custom.id,name:draft.name,mode:draft.mode};let attempts=0,builders=0;
    h.fixture.routes.transactions=async(part,options)=>{h.fixture.transactionAttempts.push(options.body);if(++attempts===1){h.fixture.revision++;h.fixture.state.events.push(event);h.fixture.groups.push({...custom,name:draft.name});h.fixture.receipt={revision:h.fixture.revision,delta:{tasks:[],batches:[],events:[event]},groups:h.fixture.groups};throw Error('synthetic lost response');}return ok(h.fixture.receipt);};
    await h.store.transact(()=>{builders++;return{events:[event]};});assert.equal(builders,1);assert.equal(attempts,2);assert.equal(h.fixture.transactionAttempts[0],h.fixture.transactionAttempts[1]);assert.equal(h.store.read().events.length,1);assert.equal(h.store.groups().length,2);assert.deepEqual(draft,snapshot);
  });
  await run('failed save preserves directory, task history, session and draft; next save can retry',async()=>{
    const h=harness(admin);await h.store.init();const prior=h.store.read(),draft={name:'保留草稿',mode:'multi'},snapshot=copy(draft);let attempts=0;h.fixture.routes.transactions=()=>{attempts++;throw Error('network');};await assert.rejects(h.store.transact(()=>({events:[{id:'e',type:'group_created',name:draft.name}]})),/暂时无法连接/);assert.equal(attempts,2);assert.deepEqual(draft,snapshot);assert.equal(h.store.read().events.length,prior.events.length);assert.equal(h.store.groups().length,1);assert.equal(h.store.profile().role,'admin');h.fixture.routes.transactions=()=>ok({revision:1,delta:{tasks:[],events:[{id:'e',type:'group_created',groupId:custom.id,name:draft.name}],batches:[]},groups:[...base,custom]});h.fixture.routes.state=()=>ok({revision:h.store.revision(),delta:{tasks:[],events:[],batches:[]}});await h.store.transact(()=>({events:[{id:'e',type:'group_created',name:draft.name}]}));assert.equal(h.store.revision(),1);assert.equal(h.store.groups().length,2);
  });
  await run('revision conflict retries fresh snapshot and does not duplicate or lose user input',async()=>{
    const h=harness(admin);await h.store.init();const draft={name:'并发新增',mode:'multi'};let attempts=0,builders=0;h.fixture.routes.transactions=(part,options)=>{attempts++;if(attempts===1){h.fixture.revision=1;return fail(409,'REVISION_CONFLICT');}const request=JSON.parse(options.body);assert.equal(request.revision,1);h.fixture.revision=2;h.fixture.state.events.push(...request.delta.events);h.fixture.groups.push(custom);return ok({revision:2,delta:{tasks:[],batches:[],events:request.delta.events},groups:h.fixture.groups});};await h.store.transact(()=>{builders++;return{events:[{id:'event_'+randomUUID(),type:'group_created',groupId:custom.id,name:draft.name}]};});assert.equal(attempts,2);assert.equal(builders,2);assert.equal(h.store.read().events.length,1);assert.equal(draft.name,'并发新增');
  });
  console.log(JSON.stringify({ok:true,checks,checkCount:checks.length,sharedStoreSha256:createHash('sha256').update(source).digest('hex'),productionBusinessWrites:0},null,2));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
