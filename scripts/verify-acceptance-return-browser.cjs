'use strict';
// Real Chromium and exact immutable assets, with synthetic read-only API replies.
// No production data, sessions or mutations are used.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {createHash}=require('node:crypto');
const {chromium}=require('C:/Users/yeddashang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'group-workbench'),out=path.resolve(root,'../overview-return');
const manifest=JSON.parse(fs.readFileSync(path.join(out,'package.json')));
const checks=[],errors=[],check=(label,condition)=>{assert(condition,label);checks.push(label);console.log('PASS '+label);};
const state={version:3,tasks:[],events:[],batches:[],preferences:{}};
let sequence=0;
function add(groupId,mode,name,actions){
  const id=groupId+'-'+name;
  state.tasks.push({id,tid:id,groupId,mode,movie:'隔离验收统计验证',date:'2026-09-01',createdAt:'2026-09-01T00:00:00Z'});
  const history=[['dispatch',1],['claim',2],['submit',2],['qc_pass',2],...actions];
  for(const [type,day,extra={}] of history)state.events.push({id:'e'+ ++sequence,taskId:id,type,at:`2026-10-${String(day).padStart(2,'0')}T01:00:00Z`,workflowVersion:3,actor:'测试人员',actorRole:type==='submit'||type==='claim'?'annotation':type.startsWith('acceptance')?'acceptance':'qc',...extra});
}
for(const [groupId,mode] of [['g01','single'],['g02','single'],['g06','multi'],['g07','multi']]){
  add(groupId,mode,'repeat',[['acceptance_fail',19,{acceptanceInspection:'fail',note:'实检不合格'}],['acceptance_fail',20,{acceptanceInspection:'uninspected',note:'整批退回'}],['acceptance_pass',20,{acceptanceInspection:'pass'}],['acceptance_pass',21,{acceptanceInspection:'pass'}]]);
  add(groupId,mode,'batch',[['acceptance_fail',20,{acceptanceInspection:'pass',note:'实检合格随批退回'}]]);
  add(groupId,mode,'reject',[['acceptance_fail',20,{note:'[验收拒绝] 历史拒绝'}]]);
  add(groupId,mode,'direct-reject',[['acceptance_reject',20,{note:'直接拒绝'}]]);
  add(groupId,mode,'released',[['acceptance_fail',19],['acceptance_pass',20],['admin_release',21]]);
  add(groupId,mode,'deleted',[['acceptance_fail',20],['task_deleted',21]]);
}
const profile={name:'admin',role:'admin'};
let revision=1,snapshot=state;
async function main(){
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    const name=pathname.endsWith('/')?'index.html':path.basename(pathname),file=path.join(web,name);
    if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const contexts=[];
  async function open(baseline=false){
    const context=await browser.newContext({viewport:{width:1540,height:1050},timezoneId:'Asia/Shanghai'});contexts.push(context);
    await context.addInitScript(({profile})=>sessionStorage.setItem('r2v-group-workbench-shared-v1:session',JSON.stringify({token:'synthetic-only',profile})),{profile});
    const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/group-workbench-api/**',async route=>{
      assert.equal(route.request().method(),'GET','metric rendering must never submit');
      const pathname=new URL(route.request().url()).pathname;
      const body=pathname.endsWith('/session')?{profile}:pathname.endsWith('/health')?{ok:true,capabilities:{acceptanceInspection:{supported:true}}}:{revision,state:snapshot};
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    if(baseline)await page.route('**/app.20261020-prod76-acceptance-return-metric.js',route=>route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(web,'app.20261020-prod75-batch-return-entry.js'),'utf8')}));
    await page.goto(origin+'/group-workbench/');await page.locator('#appShell').waitFor({state:'visible'});
    await page.locator('nav [data-view="overview"]').click();
    return page;
  }
  async function scope(page,mode,from,to,group='all'){
    await page.locator(`[data-mode="${mode}"]`).click();
    await page.locator('#scopeGroup').selectOption(group);
    await page.locator('#scopeDateFrom').fill(from);
    await page.locator('#scopeDateTo').fill(to);
    await page.locator('#scopeDateTo').dispatchEvent('change');
  }
  async function metrics(page){
    return page.evaluate(()=>Object.fromEntries([...document.querySelectorAll('.overview-metrics [id^="metric"]')].map(e=>[e.id,e.textContent])));
  }
  try{
    fs.mkdirSync(out,{recursive:true});
    const page=await open(),old=await open(true);
    const changed=new Set(['metricTodayAccept','metricTodayAcceptHint','metricTodayAcceptReturn','metricTodayAcceptReturnHint']);
    for(const mode of ['single','multi']){
      for(const [from,to,group,pass,returns] of [
        ['2026-10-19','2026-10-21','all',2,4],
        ['2026-10-20','2026-10-20','all',2,4],
        ['2026-10-21','2026-10-21','all',2,0],
        ['2026-10-19','2026-10-19','all',0,2],
        ['2026-10-19','2026-10-21',mode==='single'?'g01':'g06',1,2],
        ['2026-10-22','2026-10-22','all',0,0],
        ['2026-10-21','2026-10-19','all','—','—']
      ]){
        await scope(page,mode,from,to,group);await scope(old,mode,from,to,group);
        const now=await metrics(page),before=await metrics(old);
        check(`${mode} ${from}/${to} ${group}: pass/return counts`,now.metricTodayAccept===String(pass)&&now.metricTodayAcceptReturn===String(returns));
        for(const key of Object.keys(now))if(!changed.has(key))assert.equal(now[key],before[key],`unchanged metric ${key}`);
        checks.push(`${mode} ${from}/${to} ${group}: all unrelated cards unchanged`);
      }
    }
    await scope(page,'multi','2026-10-19','2026-10-21');
    check('return follows pass in DOM',await page.locator('#metricTodayAcceptReturn').evaluate(el=>el.parentElement.previousElementSibling.querySelector('strong').id==='metricTodayAccept'));
    for(const width of [1540,1100,760]){
      await page.setViewportSize({width,height:1050});
      const placement=await page.locator('#metricTodayAcceptReturn').evaluate(el=>{const r=el.getBoundingClientRect();return{width:r.width,visible:r.top>=0&&r.left>=0&&r.right<=innerWidth};});
      check(`return metric remains visible at width ${width}`,placement.width>0&&placement.visible);
      await page.screenshot({path:path.join(out,`overview-${width}.png`),fullPage:true});
    }
    // Keep the real acceptance Finder draft across overview navigation/filtering.
    const acceptanceContext=await browser.newContext({viewport:{width:1540,height:1050},timezoneId:'Asia/Shanghai'});contexts.push(acceptanceContext);
    const acceptance={name:'测试验收',role:'acceptance',groupId:'g01',mode:'single'};
    await acceptanceContext.addInitScript(profile=>sessionStorage.setItem('r2v-group-workbench-shared-v1:session',JSON.stringify({token:'synthetic-only',profile})),acceptance);
    const worker=await acceptanceContext.newPage();worker.on('pageerror',e=>errors.push(e.message));
    await worker.route('**/group-workbench-api/**',route=>{
      assert.equal(route.request().method(),'GET');
      const p=new URL(route.request().url()).pathname;
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(p.endsWith('/session')?{profile:acceptance}:p.endsWith('/health')?{ok:true,capabilities:{acceptanceInspection:{supported:true}}}:{revision,state:snapshot})});
    });
    await worker.goto(origin+'/group-workbench/');await worker.locator('#appShell').waitFor({state:'visible'});
    await worker.locator('nav [data-view="acceptance"]').click();await worker.locator('#acceptanceImportDetails').evaluate(el=>el.open=true);
    await worker.locator('#acceptanceText').fill('未提交验收草稿');await worker.locator('#acceptanceChoiceNote').fill('需要保留的备注');
    await worker.locator('nav [data-view="overview"]').click();await scope(worker,'single','2026-10-19','2026-10-21');
    await worker.locator('nav [data-view="acceptance"]').click();
    check('acceptance draft survives overview dates',await worker.locator('#acceptanceText').inputValue()==='未提交验收草稿'&&await worker.locator('#acceptanceChoiceNote').inputValue()==='需要保留的备注');
    // A changed server snapshot must invalidate cached date contributions.
    await page.setViewportSize({width:1540,height:1050});await scope(page,'single','2026-10-21','2026-10-21');
    snapshot=JSON.parse(JSON.stringify(state));snapshot.events.push({id:'new-after-refresh',taskId:'g01-batch',type:'acceptance_fail',at:'2026-10-21T12:00:00Z',actor:'测试验收',actorRole:'acceptance',workflowVersion:3,acceptanceInspection:'uninspected'});
    revision++;await page.locator('#sharedRefreshBtn').click();
    await page.waitForFunction(()=>document.getElementById('metricTodayAcceptReturn').textContent==='1');
    check('cloud refresh invalidates cached return count',(await metrics(page)).metricTodayAcceptReturn==='1');
    check('no browser JavaScript errors',errors.length===0);
    const sourceHashes=Object.fromEntries(Object.keys(manifest).map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(web,name))).digest('hex')]));
    assert.deepEqual(sourceHashes,manifest);
    const report={ok:true,checks,errors,sourceHashes,syntheticOnly:true,productionBusinessWrites:0};
    fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,checks:checks.length}));
  }finally{for(const c of contexts)await c.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
