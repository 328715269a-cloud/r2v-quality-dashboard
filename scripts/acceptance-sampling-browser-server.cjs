'use strict';
// Synthetic loopback-only browser fixture. Never proxies a remote service.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {randomUUID}=require('node:crypto');
const {createService}=require('../workbench-api/server.cjs');
const Flow=require('../group-workbench/workflow.js');
const root=path.resolve(__dirname,'..'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'r2v-sampling-browser-'));
const packaged=process.env.SAMPLING_TEST_PACKAGED==='1';
const packageStatic=process.env.SAMPLING_TEST_PACKAGE_DIR?path.resolve(process.env.SAMPLING_TEST_PACKAGE_DIR):path.resolve(root,'../package/static');
const port=Number(process.env.SAMPLING_TEST_PORT||43187),origin=`http://127.0.0.1:${port}`;
const service=createService({directory,groupPin:'isolated-test-group-pin',adminPin:'isolated-test-admin-pin',backupIntervalMs:0,skipStartupBackup:true,allowedOrigins:[origin]});
const profiles={admin:{name:'admin',role:'admin'},single:{name:'测试验收',role:'acceptance',groupId:'g01',mode:'single'},multi:{name:'多镜验收',role:'acceptance',groupId:'g06',mode:'multi'},annotation:{name:'旧页标注',role:'annotation',groupId:'g01',mode:'single'}};
const uid=kind=>`${kind}_${randomUUID()}`;
function tx(profile,delta){return service.transact({id:randomUUID(),revision:service.getRevision(),delta,...(profile.role==='admin'?{pin:'isolated-test-admin-pin'}:{})},profile);}
function event(task,type,extra={}){return {id:uid('event'),taskId:task.id,type,workflowVersion:3,...extra};}
function ready(prefix,count,movie,groupId='g01',mode='single',finish=false){
  const batch={id:uid('batch'),date:'2026-10-20',groupId,mode,movie};
  const tasks=Array.from({length:count},(_,i)=>({id:uid('task'),tid:`${prefix}-${String(i+1).padStart(3,'0')}`,date:batch.date,groupId,mode,movie,batchId:batch.id}));
  batch.taskIds=tasks.map(task=>task.id);
  tx(profiles.admin,{tasks,batches:[batch],events:tasks.map(task=>event(task,'dispatch'))});
  const annotation={name:'旧页标注',role:'annotation',groupId,mode},qc={name:'测试组长',role:'qc',groupId,mode};
  tx(annotation,{events:tasks.flatMap(task=>[event(task,'claim'),event(task,'submit',{round:1})])});
  tx(qc,{events:tasks.map(task=>event(task,'qc_pass',{qcRound:1}))});
  if(finish)tx(mode==='single'?profiles.single:profiles.multi,{events:tasks.map(task=>event(task,'acceptance_pass',{acceptanceRound:1}))});
  return tasks;
}
const compact=process.env.SAMPLING_TEST_COMPACT==='1';
ready('RETURN',compact?12:100,'整批退回测试');ready('PASS',compact?12:100,'随批放行测试');ready('DRAFT',3,'草稿冲突测试');
ready('MULTI',10,'多镜头抽检测试','g06','multi');ready('DONE',1,'已完成隔离保护','g01','single',true);
ready('LEGACY',2,'旧验收页兼容');
const annotationBatch={id:uid('batch'),date:'2026-10-20',groupId:'g01',mode:'single',movie:'旧标注页兼容'};
const annotationTask={id:uid('task'),tid:'LEGACY-ANNOTATION',date:annotationBatch.date,groupId:'g01',mode:'single',movie:annotationBatch.movie,batchId:annotationBatch.id};
annotationBatch.taskIds=[annotationTask.id];tx(profiles.admin,{tasks:[annotationTask],batches:[annotationBatch],events:[event(annotationTask,'dispatch')]});tx(profiles.annotation,{events:[event(annotationTask,'claim')]});
let healthSupported=true;
const mime={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(url.pathname==='/__test/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({revision:service.getRevision(),state:service.state(),tasks:service.state().tasks.map(task=>({...task,...Flow.project(task,service.state().events.filter(e=>e.taskId===task.id))}))}));return;}
    if(url.pathname==='/__test/action'&&req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));
      if(body.action==='arrive')ready('ARRIVAL',1,'整批退回测试');
      else if(body.action==='health')healthSupported=body.supported===true;
      else if(body.action==='edit'){const task=service.state().tasks.find(t=>t.tid===body.tid);if(!task)throw new Error('unknown synthetic TID');tx(profiles.admin,{events:[event(task,'metadata_edit',{before:{tid:task.tid,movie:task.movie},after:{tid:task.tid,movie:task.movie+'（并发更新）'},note:'合成冲突验证'})]});}
      else throw new Error('unsupported synthetic action');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,revision:service.getRevision()}));return;
    }
    if(url.pathname.startsWith('/group-workbench-api/')){
      if(url.pathname.endsWith('/health')&&!healthSupported){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,capabilities:{}}));return;}
      service.server.emit('request',req,res);return;
    }
    const legacy=url.pathname.startsWith('/legacy/group-workbench/');
    const filename=url.pathname.endsWith('/')?'index.html':path.basename(url.pathname);
    let file;
    if(legacy)file=path.resolve(root,'../live',filename);
    else if(url.pathname.startsWith('/group-workbench/')){
      if(packaged){
        file=[path.join(packageStatic,filename),path.join(root,'group-workbench',filename),path.resolve(root,'../live',filename)].find(candidate=>fs.existsSync(candidate))||path.join(packageStatic,filename);
      }else{
        const source=/^(app|workflow|reports|shared-store|data-io|export-worker)(?:\.[^/]+)?\.js$/.exec(filename);
        file=path.join(root,'group-workbench',source?`${source[1]}.js`:filename);
      }
    }else file=path.join(root,filename);
    if(!fs.existsSync(file)){res.writeHead(404);res.end('Missing fixture file');return;}
    let data=fs.readFileSync(file);
    if(!legacy&&!packaged&&filename==='index.html')data=Buffer.from(data.toString().replace('</head>','<link rel="stylesheet" href="styles.css"></head>'));
    res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');res.end(data);
  }catch(error){res.writeHead(500,{'Content-Type':'text/plain'});res.end(error.stack);}
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({origin,newPage:`${origin}/group-workbench/`,oldPage:`${origin}/legacy/group-workbench/`,directory,packaged,pin:'isolated-test-group-pin'})));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await new Promise(resolve=>server.close(resolve));await service.close();process.exit(0);});
