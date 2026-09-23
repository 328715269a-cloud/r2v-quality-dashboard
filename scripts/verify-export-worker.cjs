'use strict';
process.env.TZ='Asia/Shanghai';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {Worker}=require('node:worker_threads');
const Flow=require('../group-workbench/workflow.js'),Reports=require('../group-workbench/reports.js'),IO=require('../group-workbench/data-io.js');
const {createExporter}=require('../group-workbench/export-worker.js');
const directory=path.join(__dirname,'../group-workbench'),app=fs.readFileSync(path.join(directory,'app.js'),'utf8');
const groups=[{id:'g01',name:'单镜头1组',defaultMode:'single',members:[]},{id:'g02',name:'单镜头2组',defaultMode:'single',members:[]},{id:'g06',name:'多镜头1组',defaultMode:'multi',members:[]}];
function extract(name){const lines=app.split(/\r?\n/),start=lines.findIndex(line=>new RegExp(`^  (?:async )?function ${name}\\(`).test(line));assert(start>=0,name);if(lines[start].trimEnd().endsWith('}'))return lines[start];const end=lines.findIndex((line,i)=>i>start&&/^  }\s*$/.test(line));assert(end>start,name);return lines.slice(start,end+1).join('\n');}
const labels=app.match(/^  const EVENT_LABELS=.*$/m)[0];
const helpers=new Function('window','GROUPS',`${labels}\n${['groupById','groupLabel','eventLabel','eventDetail'].map(extract).join('\n')}\nreturn {eventLabels:EVENT_LABELS,groupLabel,eventLabel,eventDetail};`)({WorkbenchFlow:Flow},groups);
const date=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'':`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
let serial=0;
const state={version:3,createdAt:'2026-09-01T00:00:00Z',tasks:[],events:[],batches:[],preferences:{}};
function add(id,groupId,mode,tail=[]){const task={id,tid:id,movie:id==='a'?'=公式防护,影片':'测试影片',groupId,mode,date:'2026-09-01',createdAt:'2026-09-01T00:00:00Z',batchId:'import-'+groupId};state.tasks.push(task);let second=0;for(const e of [{type:'dispatch'},{type:'claim',actor:'张明',assignee:'张明',actorRole:'annotation'},{type:'submit',actor:'张明',actorRole:'annotation',submissionKind:'initial'},...tail])state.events.push({id:'ev-'+(++serial),taskId:id,actor:'测试组长',actorRole:'qc',workflowVersion:3,at:new Date(Date.UTC(2026,8,20,16,0,second++)).toISOString(),...e});}
add('a','g01','single',[{type:'qc_fail',pLevel:'P1',tags:['主体/对象漏标'],note:'首检,多行\n说明'},{type:'claim',assignmentKind:'rework_transfer',fromAssignee:'张明',assignee:'李明',actor:'组长',actorRole:'qc',assignmentStatus:'rework'},{type:'submit',actor:'张明',actorRole:'annotation',submissionKind:'rework'},{type:'submit',actor:'李明',assignee:'李明',actorRole:'annotation',submissionKind:'rework'},{type:'qc_pass'},{type:'acceptance_pass'}]);
add('b','g02','single',[{type:'qc_fail',pLevel:'P0',note:'[质检拒绝] 无法继续'}]);
add('c','g06','multi',[{type:'qc_pass'},{type:'acceptance_fail',note:'[验收拒绝] 需要废弃'}]);
add('deleted','g01','single',[{type:'qc_pass'},{type:'task_deleted',note:'删除测试',deletedBatchId:'import-g01'}]);
state.events.push({id:'setting',taskId:'group:g01',type:'group_daily_edit',groupId:'g01',mode:'single',date:'2026-09-21',at:'2026-09-21T02:00:00Z',after:{leader:'测试组长',total:100,headcount:1.5},note:'设置'});
for(const group of groups){const tasks=state.tasks.filter(task=>task.groupId===group.id);state.batches.push({id:'import-'+group.id,groupId:group.id,mode:group.defaultMode,movie:'导入时片名',kind:'import',date:'2026-09-01',taskIds:tasks.map(task=>task.id),tids:tasks.map(task=>task.tid)});}
state.batches.push({id:'package-a',kind:'handoff',stage:'qc',mode:'single',groupId:'g01',packageName:'历史包',taskIds:['a','c'],tids:['旧a','旧c'],createdAt:'2026-09-21T01:00:00Z'});
state.events.push({id:'package-claim',taskId:'a',type:'package_claimed',packageId:'package-a',stage:'qc',at:'2026-09-21T02:00:00Z',actor:'包质检'});
const statusMeta=Flow.STATUS_META,exporter=createExporter(Flow,Reports,IO),original=JSON.stringify(state);
const request=(kind,scope={})=>({kind,groups,statusMeta,eventLabels:helpers.eventLabels,scope:{profile:{role:'admin',name:'管理员'},mode:'single',groupId:'all',range:'all',dateFrom:'',dateTo:'',...scope}});
function reference(req){const canView=id=>['admin','acceptance'].includes(req.scope.profile.role)||id===req.scope.profile.groupId;const auditTasks=state.tasks.filter(task=>canView(task.groupId)&&task.mode===req.scope.mode&&(req.scope.groupId==='all'||task.groupId===req.scope.groupId)).map(task=>({...task,...Flow.project(task,state.events.filter(event=>event.taskId===task.id))}));const tasks=auditTasks.filter(task=>!task.deleted).map(task=>({...task,statusLabel:Flow.label(task)}));return Reports.build({state,tasks,auditTasks,groups:groups.filter(group=>canView(group.id)&&group.defaultMode===req.scope.mode&&(req.scope.groupId==='all'||group.id===req.scope.groupId)),mode:req.scope.mode,statusMeta,...helpers,localDate:date});}
function chosen(reports,kind,scope){let report=reports[kind];if(kind==='summary'){const columns=new Map([...reports.groups.columns,...reports.movies.columns].map(column=>[column.key,column]));report={columns:[{key:'scope',label:'汇总层级'},...columns.values()],rows:[...reports.groups.rows.map(row=>({...row,scope:'小组'})),...reports.movies.rows.map(row=>({...row,scope:'影片'}))]};}if(scope.range==='scope')report={...report,rows:report.rows.filter(row=>{const d=String(row.date);return !!d&&(!scope.dateFrom||d>=scope.dateFrom)&&(!scope.dateTo||d<=scope.dateTo);})};return report;}

async function main(){
 let comparisons=0;
 for(const scope of [{},{groupId:'g01'},{mode:'multi'},{profile:{role:'qc',groupId:'g02',name:'组长'}},{range:'scope',dateFrom:'2026-09-21',dateTo:'2026-09-21'},{range:'scope',dateFrom:'2030-01-01',dateTo:'2030-01-02'}]){
  for(const kind of ['imports','tasks','events','packages','movies','groups','daily','personDaily','summary']){
   const req=request(kind,scope),reports=reference(req),expected=chosen(reports,kind,req.scope),actual=exporter.generate(req,state);
   assert.equal(Buffer.from(await actual.blob.arrayBuffer()).toString('utf8'),IO.csv(expected.columns,expected.rows),`${kind} export bytes and field order`);assert.equal(actual.rowCount,expected.rows.length);comparisons++;
  }
 }
 const backup={format:'r2v-workbench-shared-backup',version:1,exportedAt:'2026-09-23T00:00:00Z',revision:42,state,transactions:[{id:'tx1',revision:42,profile:{role:'admin'},result:{events:['ev-1']}}]};
 const expected={...backup,latestTasks:state.tasks.map(task=>({...task,...Flow.project(task,state.events)}))};
 assert.equal(Buffer.from(await exporter.generate(request('backup'),state,backup).blob.arrayBuffer()).toString('utf8'),JSON.stringify(expected,null,2),'backup bytes, original state, transactions, and all-mode projections remain exact');
 assert.throws(()=>exporter.generate(request('backup',{profile:{role:'qc',groupId:'g01'}}),state,backup),/管理员/);
 assert.throws(()=>exporter.generate(request('tasks',{range:'scope',dateFrom:'2026-09-22',dateTo:'2026-09-21'}),state),/日期/);
 assert.equal(JSON.stringify(state),original,'export must not mutate raw records');
 const projected=state.tasks.map(task=>({...task,...Flow.project(task,state.events.filter(event=>event.taskId===task.id))}));
 const input={state,tasks:projected.filter(task=>!task.deleted),auditTasks:projected,groups,statusMeta,...helpers,localDate:date};
 const full=Reports.build(input);
 for(const kind of Object.keys(full)){const single=Reports.build({...input,kind});assert.deepEqual(Object.keys(single),[kind]);assert.deepEqual(single[kind],full[kind],kind+' optional build retains legacy output');}
 const cyclic={id:'unused',tid:'unused',groupId:'g01',mode:'single',movie:'懒构建',status:'unclaimed'};cyclic.extra=cyclic;
 assert.doesNotThrow(()=>Reports.build({state:{tasks:[cyclic],events:[],batches:[]},tasks:[cyclic],groups,statusMeta,kind:'movies'}),'selected summary must not serialize unused task timelines');
 await testMainFlow();
 const metrics=await testThread(backup);
 console.log(JSON.stringify({ok:true,byteIdenticalCsvComparisons:comparisons,backupByteIdentical:true,kindBuildEquivalent:true,mainFlowGuards:true,...metrics},null,2));
}

async function testMainFlow(){
 const downloads=[],messages=[],buttons=[{disabled:false,setAttribute(){},removeAttribute(){}}];let release;
 const wait=new Promise(resolve=>{release=resolve;});
 const h=new Function('deps',`let exportJob=null,state=null,activeMode='single',profile={role:'admin',name:'管理员'};const Blob=deps.Blob,Worker=function(){},GROUPS=[],STATUS_META={},EVENT_LABELS={};
 const qsa=()=>deps.buttons,selectedGroup=()=> 'all',scopeRangeKey=()=> '|',selectedRange=()=>({dateFrom:'',dateTo:''}),validScopeRange=()=>true,scopeRangeLabel=()=> '全部日期',modeLabel=()=> '单镜头',todayString=()=> '2026-09-23';
 const showToast=(text)=>deps.messages.push(text),setExportStatus=showToast,download=(...args)=>deps.downloads.push(args),store={refresh:async()=>{},read:()=>({tasks:[],events:[],batches:[]}),backup:async()=>{throw Error('网络失败');}};
 const generateExport=async()=>{await deps.wait;return {blob:new Blob(['ok']),rowCount:1};};
 ${extract('exportScopeCurrent')}\n${extract('exportData')}
 return {run:exportData,setProfile:value=>{profile=value;},busy:()=>!!exportJob};`)({Blob,buttons,downloads,messages,wait});
 const first=h.run('tasks');await new Promise(resolve=>setImmediate(resolve));assert(h.busy());assert(buttons[0].disabled);
 await h.run('tasks');assert(messages.some(text=>text.includes('已有导出')),'duplicate job is blocked');
 h.setProfile({role:'qc',name:'新组长',groupId:'g02'});release();await first;assert.equal(downloads.length,0,'identity changes cancel downloading');assert(!h.busy());assert(!buttons[0].disabled);
 h.setProfile({role:'admin',name:'管理员'});await h.run('backup');assert(messages.includes('网络失败'));assert(!h.busy());assert(!buttons[0].disabled,'failure restores export controls');
 await h.run('tasks');assert.equal(downloads.length,1,'failure does not block a later successful export');
}

async function testThread(backup){
 const wrapper=`const {parentPort,workerData}=require('node:worker_threads'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');const ctx={Blob,URL,location:{href:'https://isolated.test/group-workbench/export-worker.js',origin:'https://isolated.test'},postMessage:value=>parentPort.postMessage(value)};ctx.self=ctx;vm.createContext(ctx);ctx.importScripts=url=>vm.runInContext(fs.readFileSync(path.join(workerData,new URL(url).pathname.split('/').pop()),'utf8'),ctx);vm.runInContext(fs.readFileSync(path.join(workerData,'export-worker.js'),'utf8'),ctx);parentPort.on('message',data=>ctx.onmessage({data}));`;
 const worker=new Worker(wrapper,{eval:true,workerData:directory});
 try{
  const huge={version:3,createdAt:'2026-09-01',tasks:[],events:[],batches:[],preferences:{}};
  for(let i=0;i<12000;i++){const id='scale-'+i;huge.tasks.push({id,tid:id,groupId:'g01',mode:'single',movie:'规模影片',date:'2026-09-20'});for(const [n,type]of ['claim','submit','qc_pass','acceptance_pass'].entries())huge.events.push({id:id+'-'+n,taskId:id,type,workflowVersion:3,at:'2026-09-21T01:00:00Z',actor:'标注人',assignee:'标注人'});}
  const done=new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',msg=>{if(msg.type==='error')reject(Error(msg.message));else if(msg.type==='complete')resolve(msg);});});
  const header={...huge,tasks:[],events:[],batches:[]},backupHeader={...backup,state:{},transactions:[]};
  worker.postMessage({type:'start',request:request('backup'),dependencies:['workflow.js','data-io.js','reports.js'].map(name=>'https://isolated.test/group-workbench/'+name),state:header,backup:backupHeader});
  let ticks=0,maxGap=0,previous=performance.now();const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-previous);previous=now;ticks++;},5);
  const started=performance.now();
  try{
   for(const collection of ['tasks','events'])for(let i=0;i<huge[collection].length;i+=250){worker.postMessage({type:'chunk',collection,rows:huge[collection].slice(i,i+250)});await new Promise(resolve=>setTimeout(resolve,0));}
   worker.postMessage({type:'chunk',collection:'transactions',rows:backup.transactions});worker.postMessage({type:'generate'});
   const result=await done,elapsed=performance.now()-started;
   assert.equal(result.rowCount,huge.tasks.length);assert(result.blob.size>1000000);assert(ticks>=10,'main event loop must continue throughout worker export');assert(maxGap<250,`worker generation main event loop gap ${maxGap.toFixed(1)} ms; ${ticks} ticks during ${elapsed.toFixed(1)} ms; ${result.blob.size} bytes`);
   const decoded=JSON.parse(Buffer.from(await result.blob.arrayBuffer()).toString('utf8'));assert.equal(decoded.latestTasks.length,12000);assert(decoded.latestTasks.every(task=>task.status==='accepted'));assert.deepEqual(decoded.transactions,backup.transactions);
   return {scaleTasks:huge.tasks.length,scaleEvents:huge.events.length,outputBytes:result.blob.size,elapsedMs:Math.round(elapsed),mainThreadTicks:ticks,maxMainThreadTickGapMs:Number(maxGap.toFixed(1))};
  }finally{clearInterval(timer);}
 }finally{await worker.terminate();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
