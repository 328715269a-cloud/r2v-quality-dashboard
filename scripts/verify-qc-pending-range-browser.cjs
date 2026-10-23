'use strict';
// Exact immutable UI, one Chrome instance, synthetic GET-only API responses.
// No SQLite/API service startup and no production data or business writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {createHash}=require('node:crypto');
const {chromium}=require('C:/Users/yeddashang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const Flow=require('../group-workbench/workflow.js');
const root=path.resolve(__dirname,'..'),web=path.join(root,'group-workbench'),out=path.resolve(root,'../qc-pending-range');
const candidate='app.20261023-prod80-qc-pending.js',baseline='app.20261023-prod79-uninspected-pass.js';
const checks=[],errors=[],snapshots=[],contexts=[];
const check=(label,value)=>{assert(value,label);checks.push(label);console.log('PASS '+label);};
const state={version:3,tasks:[],events:[],batches:[],preferences:{}};
let sequence=0,revision=1,snapshot=state;
const groupsFor=mode=>mode==='single'?['g01','g02']:['g06','g07'];
const at=(day,order=0)=>`2026-10-${String(day).padStart(2,'0')}T09:${String(order).padStart(2,'0')}:00+08:00`;
function add(groupId,mode,name,actions){
  const id=groupId+'-'+name;
  state.tasks.push({id,tid:id,groupId,mode,movie:'待质检口径合成验证',date:'2026-09-01',createdAt:'2026-09-01T00:00:00Z'});
  const history=[['dispatch',16],['claim',16],...actions];
  history.forEach(([type,day,extra={}],index)=>state.events.push({id:'pending-event-'+ ++sequence,taskId:id,type,at:at(day,index),workflowVersion:3,actor:'合成标注',assignee:'合成标注',actorRole:type==='claim'||type==='submit'?'annotation':type.startsWith('acceptance')?'acceptance':type.startsWith('admin')||type==='task_deleted'?'admin':'qc',...extra}));
}
for(const [groupId,mode] of [['g01','single'],['g02','single'],['g06','multi'],['g07','multi']]){
  add(groupId,mode,'first',[['submit',20]]);
  add(groupId,mode,'second',[['submit',19],['qc_fail',19],['submit',20]]);
  add(groupId,mode,'third',[['submit',18],['qc_fail',18],['submit',19],['qc_fail',19],['submit',21]]);
  add(groupId,mode,'fourth',[['submit',17],['qc_fail',17],['submit',18],['qc_fail',18],['submit',19],['qc_fail',19],['submit',20]]);
  add(groupId,mode,'acceptance-repair',[['submit',17],['qc_pass',18],['acceptance_fail',19,{acceptanceInspection:'fail'}],['acceptance_route',19,{route:'annotation'}],['submit',21]]);
  add(groupId,mode,'previous',[['submit',19]]);
  add(groupId,mode,'unsubmitted',[]);
  add(groupId,mode,'repair-wait',[['submit',20],['qc_fail',20]]);
  add(groupId,mode,'passed',[['submit',20],['qc_pass',20]]);
  add(groupId,mode,'rejected',[['submit',20],['qc_reject',20,{note:'拒绝测试'}]]);
  add(groupId,mode,'released',[['submit',20],['admin_release',21]]);
  add(groupId,mode,'deleted',[['submit',20],['task_deleted',21]]);
}
const projected=()=>snapshot.tasks.map(task=>({...task,...Flow.project(task,snapshot.events.filter(event=>event.taskId===task.id))}));
async function main(){
  fs.mkdirSync(out,{recursive:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(out,'package.json'),'utf8'));
  let browser,server,failure,origin;
  async function open(profile={name:'admin',role:'admin'},old=false){
    const context=await browser.newContext({viewport:{width:1540,height:1080},timezoneId:'Asia/Shanghai'});contexts.push(context);
    await context.addInitScript(profile=>sessionStorage.setItem('r2v-group-workbench-shared-v1:session',JSON.stringify({token:'synthetic-only',profile})),profile);
    const page=await context.newPage();page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(120000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==origin){errors.push('Blocked non-local request '+request.url());await route.abort();return;}
      if(url.pathname.startsWith('/group-workbench-api/')){
        if(request.method()!=='GET'){errors.push('Forbidden synthetic mutation '+url.pathname);await route.abort();return;}
        const body=url.pathname.endsWith('/session')?{profile}:url.pathname.endsWith('/health')?{ok:true,capabilities:{acceptanceInspection:{supported:true}}}:{revision,state:snapshot};
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});return;
      }
      if(old&&url.pathname.endsWith('/'+candidate)){await route.fulfill({status:200,contentType:'text/javascript',body:fs.readFileSync(path.join(web,baseline),'utf8')});return;}
      await route.continue();
    });
    await page.goto(origin+'/group-workbench/',{timeout:120000});await page.locator('#appShell').waitFor({state:'visible',timeout:120000});
    await page.locator('nav [data-view="overview"]').click();return page;
  }
  async function scope(page,mode,from,to,group='all'){
    await page.locator(`[data-mode="${mode}"]`).click();await page.locator('#scopeGroup').selectOption(group);
    await page.locator('#scopeDateFrom').fill(from);await page.locator('#scopeDateTo').fill(to);await page.locator('#scopeDateTo').dispatchEvent('change');
  }
  const metrics=page=>page.evaluate(()=>Object.fromEntries([...document.querySelectorAll('.overview-metrics [id^="metric"]')].map(node=>[node.id,node.textContent])));
  try{
    const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
    server=http.createServer((req,res)=>{
      const pathname=new URL(req.url,'http://localhost').pathname,name=pathname.endsWith('/')?'index.html':path.basename(pathname),file=path.join(web,name);
      if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type',mime[path.extname(name)]||'application/octet-stream');res.end(fs.readFileSync(file));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
    console.log('Lightweight GET-only fixture ready: '+origin);
    for(let attempt=0;attempt<2;attempt++){
      try{browser=await chromium.launch({headless:true,timeout:120000,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});break;}
      catch(error){if(attempt||!String(error.message).includes('Timeout'))throw error;console.log('Retrying owned Chrome startup once; synthetic fixture retained.');}
    }
    const page=await open(),old=await open(undefined,true);
    check('prod80 immutable app loaded',await page.locator(`script[src="${candidate}"]`).count()===1&&await page.evaluate(()=>window.GroupWorkbench.version)==='20261023-prod80');
    check('prod79 baseline is real prior immutable code',await old.evaluate(()=>window.GroupWorkbench.version)==='20261023-prod79');
    const changed=new Set(['metricTodayQcPending','metricTodayQcPendingHint','metricTodayReworkPending']);
    for(const mode of ['single','multi']){
      const group=groupsFor(mode)[0];
      for(const [name,status,round] of [['first','pending_qc',1],['second','pending_reqc',2],['third','pending_reqc',3],['fourth','pending_reqc',4],['acceptance-repair','pending_reqc',2]]){
        const task=projected().find(task=>task.id===group+'-'+name);
        check(`${mode} fixture ${name}: genuine workflow projection`,task.status===status&&task.qcRound===round);
      }
      for(const [from,to,selected,expected] of [
        ['2026-10-20','2026-10-20','all',6],
        ['2026-10-21','2026-10-21','all',4],
        ['2026-10-19','2026-10-19','all',2],
        ['2026-10-20','2026-10-21','all',10],
        ['2026-10-17','2026-10-21','all',12],
        ['2026-10-20','2026-10-21',group,5],
        ['2026-10-21','2026-10-21',groupsFor(mode)[1],2],
        ['','','all',12],
        ['2026-10-22','2026-10-22','all',0],
        ['2026-10-21','2026-10-19','all','—']
      ]){
        await scope(page,mode,from,to,selected);await scope(old,mode,from,to,selected);
        const now=await metrics(page),prior=await metrics(old),label=`${mode} ${from||'all'}..${to||'all'} ${selected}`;
        check(`${label}: pending includes current resubmission round`,now.metricTodayQcPending===String(expected));
        if(expected!=='—')check(`${label}: hint explicitly includes resubmission`,now.metricTodayQcPendingHint.includes('返修')&&!now.metricTodayQcPendingHint.includes('首交'));
        for(const key of Object.keys(now))if(!changed.has(key))assert.equal(now[key],prior[key],`${label}: unchanged ${key}`);
        check(`${label}: every unrelated metric equals prod79`,true);
        if(expected!=='—')check(`${label}: resubmitted tasks no longer inflate pending repairs`,Number(now.metricTodayReworkPending)<=Number(prior.metricTodayReworkPending));
        snapshots.push({label,pending:now.metricTodayQcPending,repairs:now.metricTodayReworkPending,priorPending:prior.metricTodayQcPending,priorRepairs:prior.metricTodayReworkPending});
      }
      await scope(page,mode,'','','all');const card=Number((await metrics(page)).metricTodayQcPending);let queueTotal=0;
      for(const groupId of groupsFor(mode)){
        const qc=await open({name:'合成组长',role:'qc',groupId,mode});await qc.locator('nav [data-view="qc"]').click();await qc.locator('#qcTaskFilter').selectOption('review');
        const rows=await qc.locator('#qcQueueBody tr').allTextContents(),count=await qc.locator('#qcQueueBody input[name="qcTask"]').count();queueTotal+=count;
        check(`${mode} ${groupId}: QC review queue contains six pending tasks`,count===6);
        check(`${mode} ${groupId}: queue includes first second third fourth and acceptance-repair`,['first','second','third','fourth','acceptance-repair'].every(name=>rows.some(text=>text.includes(groupId+'-'+name))));
        check(`${mode} ${groupId}: unfinished repairs, passed, rejected, released and deleted stay out`,['repair-wait','passed','rejected','released','deleted','unsubmitted'].every(name=>!rows.some(text=>text.includes(groupId+'-'+name))));
        await qc.context().close();
      }
      check(`${mode}: all-date overview total exactly equals QC review queues`,card===queueTotal);
      await scope(page,mode,'2026-10-20','2026-10-21','all');
      await page.screenshot({path:path.join(out,`${mode}-qc-pending-overview.png`),fullPage:true});
      console.log(mode+' complete');
    }
    // Synthetic shared snapshot changes prove cache invalidation without writes.
    await scope(page,'single','2026-10-20','2026-10-20','g01');
    snapshot=JSON.parse(JSON.stringify(state));snapshot.events.push({id:'synced-qc-pass',taskId:'g01-first',type:'qc_pass',at:at(21,20),workflowVersion:3,actor:'合成组长',actorRole:'qc'});revision++;
    await page.locator('#sharedRefreshBtn').click();await page.waitForFunction(()=>document.getElementById('metricTodayQcPending').textContent==='2');
    check('cloud refresh removes a just-reviewed task from waiting count',(await metrics(page)).metricTodayQcPending==='2');
    const worker=await open({name:'合成验收',role:'acceptance',groupId:'g01',mode:'single'});
    await worker.locator('nav [data-view="acceptance"]').click();await worker.locator('#acceptanceImportDetails').evaluate(el=>el.open=true);
    await worker.locator('#acceptanceText').fill('未提交的验收 TID 草稿');await worker.locator('#acceptanceChoiceNote').fill('日期切换与同步之后仍需保留的说明');
    await worker.locator('nav [data-view="overview"]').click();await scope(worker,'single','2026-10-21','2026-10-21','all');
    check('before synchronized resubmission the selected day has four pending tasks',(await metrics(worker)).metricTodayQcPending==='4');
    snapshot=JSON.parse(JSON.stringify(snapshot));snapshot.events.push({id:'synced-repair-submit',taskId:'g01-repair-wait',type:'submit',at:at(21,21),workflowVersion:3,actor:'合成标注',assignee:'合成标注',actorRole:'annotation'});revision++;
    await worker.locator('#sharedRefreshBtn').click();await worker.locator('#sharedNewUpdatesLabel').waitFor({state:'visible'});
    check('with a work draft cloud sync defers rerender to preserve input',await worker.locator('#sharedNewUpdatesLabel').isVisible());
    await worker.locator('nav [data-view="acceptance"]').click();
    check('sync preserves the active work draft',await worker.locator('#acceptanceText').inputValue()==='未提交的验收 TID 草稿'&&await worker.locator('#acceptanceChoiceNote').inputValue()==='日期切换与同步之后仍需保留的说明');
    await worker.locator('nav [data-view="overview"]').click();await worker.waitForFunction(()=>document.getElementById('metricTodayQcPending').textContent==='5');
    check('safe navigation after sync includes newly resubmitted repairs in correct day',(await metrics(worker)).metricTodayQcPending==='5');
    await worker.locator('nav [data-view="acceptance"]').click();
    check('unsaved TIDs and note survive navigation dates and cloud refresh',await worker.locator('#acceptanceText').inputValue()==='未提交的验收 TID 草稿'&&await worker.locator('#acceptanceChoiceNote').inputValue()==='日期切换与同步之后仍需保留的说明');
    check('no JavaScript errors external requests or attempted business writes',errors.length===0);
    const actual=Object.fromEntries(Object.keys(manifest).map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(web,name))).digest('hex')]));
    assert.deepEqual(actual,manifest);check('all frozen release file hashes remain exact',true);
  }catch(error){failure=error;errors.push(error.stack||String(error));}
  finally{
    for(const context of contexts)await context.close().catch(()=>{});
    if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
    const sourceHashes=Object.fromEntries(Object.keys(manifest).map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(web,name))).digest('hex')]));
    const report={ok:!failure,checks,errors,sourceHashes,snapshots,syntheticOnly:true,productionBusinessWrites:0};
    fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,checks:checks.length,errors}));
  }
  if(failure)throw failure;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
