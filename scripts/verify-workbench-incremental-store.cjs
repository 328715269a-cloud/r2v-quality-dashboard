'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const code=fs.readFileSync(require.resolve('../group-workbench/shared-store.js'),'utf8');
function harness(profile){
 const responses=[],requests=[],window={};let saved=JSON.stringify({token:'isolated',profile});
 vm.runInNewContext(code,{window,sessionStorage:{getItem:()=>saved,setItem:(k,v)=>saved=v,removeItem:()=>saved=null},AbortSignal,crypto:require('node:crypto').webcrypto,fetch:async(url,options)=>{
  requests.push({url,method:options.method||'GET'});let body;
  if(url.endsWith('/session'))body=options.method==='POST'?{token:'next-isolated',profile:JSON.parse(options.body).profile}:{profile};
  else {assert.ok(responses.length,'unexpected state request '+url);body=responses.shift();}
  return{ok:true,json:async()=>body};
 }});
 return{store:window.WorkbenchStore.create(),responses,requests};
}
const plain=x=>JSON.parse(JSON.stringify(x));
(async()=>{
 const h=harness({name:'测试标注',role:'annotation',groupId:'g01',mode:'single'}),task={id:'t1',tid:'A',groupId:'g01'},other={id:'t2',tid:'B',groupId:'g02'};
 h.responses.push({revision:2,state:{tasks:[task,other],events:[{id:'e1',taskId:'t1'},{id:'e2',taskId:'t2'}],batches:[]}});await h.store.init();
 assert.deepEqual(plain(h.store.read().tasks),[task]);assert.equal(h.store.read().events.length,1);assert.ok(h.requests.at(-1).url.endsWith('state?scope=role-v1'));
 const before=h.store.read();h.responses.push({revision:3,delta:{events:[{id:'e3',taskId:'t2'}]}});assert.equal(await h.store.refresh(),false);assert.equal(h.store.read(),before);assert.equal(h.store.revision(),3);
 h.responses.push({revision:4,delta:{events:[{id:'e4',taskId:'t1'}]}});assert.equal(await h.store.refresh(),true);assert.equal(h.store.read().events.length,2);assert.equal(before.events.length,1);assert.equal(h.store.read().tasks,before.tasks);
 const stable=h.store.read();h.responses.push({revision:5,delta:{tasks:[{id:'t3',tid:'C',groupId:'g01'}],events:[{id:'e4',taskId:'t1',note:'conflicting history'}]}});await assert.rejects(h.store.refresh(),/冲突/);assert.equal(h.store.read(),stable);assert.equal(h.store.revision(),4);
 h.responses.push({revision:5,delta:{tasks:[{id:'t3',tid:'C',groupId:'g01'}],events:[{id:'e5',taskId:'t3'}]}});await h.store.refresh();assert.equal(h.store.read().tasks.length,2);assert.equal(h.store.read().events.length,3);
 h.responses.push({revision:6,state:{tasks:[task],events:[{id:'e1',taskId:'t1'}],batches:[]}});await h.store.refresh();assert.equal(h.store.read().tasks.length,1);assert.equal(h.store.read().events.length,1);
 h.responses.push({revision:7,delta:{events:[{id:'e5',taskId:'t1'}]}});await h.store.refresh();assert.equal(h.store.read().events.length,2);
 h.responses.push({revision:7,state:{tasks:[other],events:[{id:'e2',taskId:'t2'}],batches:[]}});await h.store.signIn({name:'测试质检',role:'qc',groupId:'g02',mode:'single'},'local');assert.ok(h.requests.at(-1).url.endsWith('state?scope=role-v1'));assert.deepEqual(plain(h.store.read().tasks),[other]);
 const big=harness({name:'admin',role:'admin'}),count=100000;big.responses.push({revision:1,state:{tasks:[],events:Array.from({length:count},(_,i)=>({id:'history-'+i,taskId:'s',at:'2026-09-20T00:00:00Z'})),batches:[]}});await big.store.init();
 const start=performance.now();for(let i=0;i<20;i++){big.responses.push({revision:2+i,delta:{events:[{id:'new-'+i,taskId:'s'}]}});await big.store.refresh();}const elapsed=performance.now()-start;assert.equal(big.store.read().events.length,count+20);
 console.log(JSON.stringify({ok:true,checks:['legacy unscoped payload safely filtered','role scoped protocol','unrelated revision preserves state identity','append keeps prior snapshot immutable','cross-collection conflict atomicity','retry after rejected partial update','full snapshot clears indexes','identity change full reload'],largeHistory:count,incrementalUpdates:20,elapsedMs:+elapsed.toFixed(2)},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
