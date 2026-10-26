'use strict';
// Isolated real Chrome, exact frozen assets, synthetic read-only API. No live writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {createHash}=require('node:crypto');
const {chromium}=require('C:/Users/yeddashang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const Flow=require('../group-workbench/workflow.js'),Reports=require('../group-workbench/reports.js'),IO=require('../group-workbench/data-io.js');
const {createExporter}=require('../group-workbench/export-worker.js');
const root=path.resolve(__dirname,'..'),web=path.join(root,'group-workbench'),out=path.resolve(root,'../newcomer-group');
const groupId='m_newcomer',groupName='多镜头新人组',checks=[],errors=[],contexts=[];
const check=(label,value)=>{assert(value,label);checks.push(label);console.log('PASS '+label);};
const state={version:3,tasks:[],events:[],batches:[],preferences:{scopeDateFrom:'',scopeDateTo:''}};
for(const [group,mode] of [[groupId,'multi'],['g06','multi'],['g01','single']]){
  for(const kind of ['claim','submit','free']){
    const id=group+'-'+kind;
    state.tasks.push({id,tid:id.toUpperCase(),movie:group===groupId?'新人组验证影片':'原小组验证影片',groupId:group,mode,date:'2026-10-26',createdAt:'2026-10-26T00:00:00Z'});
    const types=['dispatch',...(kind==='free'?[]:['claim']),...(kind==='submit'?['submit']:[])];
    types.forEach((type,i)=>state.events.push({id:id+'-'+type,taskId:id,type,at:`2026-10-26T09:0${i}:00+08:00`,workflowVersion:3,actor:'合成人员',assignee:'合成人员',actorRole:type==='dispatch'?'admin':'annotation'}));
  }
}
async function main(){
  fs.mkdirSync(out,{recursive:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(out,'package.json'),'utf8')).static;
  const hashFiles=()=>Object.fromEntries(Object.keys(manifest).map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(web,name))).digest('hex')]));
  assert.deepEqual(hashFiles(),manifest,'frozen files match manifest before test');
  let browser,server,origin,failure;
  const sourceBefore=JSON.stringify(state),businessWrites=[];
  const options=async(page,selector)=>page.locator(selector+' option').evaluateAll(nodes=>nodes.map(node=>({value:node.value,label:node.textContent})));
  const bounded=promise=>Promise.race([promise,new Promise(resolve=>{const timer=setTimeout(resolve,10000);timer.unref();})]);
  async function open(profile){
    const context=await browser.newContext({viewport:{width:1600,height:1080},timezoneId:'Asia/Shanghai',acceptDownloads:true});contexts.push(context);
    if(profile)await context.addInitScript(profile=>sessionStorage.setItem('r2v-group-workbench-shared-v1:session',JSON.stringify({token:'synthetic-only',profile})),profile);
    const page=await context.newPage();page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(120000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==origin){errors.push('Blocked non-local request '+request.url());await route.abort();return;}
      if(url.pathname.startsWith('/group-workbench-api/')){
        if(request.method()!=='GET'){businessWrites.push(url.pathname);await route.abort();return;}
        const body=url.pathname.endsWith('/session')?{profile}:url.pathname.endsWith('/health')?{ok:true,capabilities:{acceptanceInspection:{supported:true}}}:{revision:1,state};
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});return;
      }
      await route.continue();
    });
    await page.goto(origin+'/group-workbench/');
    await page.locator(profile?'#appShell':'#identityGate').waitFor({state:'visible',timeout:120000});
    return page;
  }
  try{
    server=http.createServer((req,res)=>{
      const url=new URL(req.url,'http://localhost'),name=url.pathname.endsWith('/')?'index.html':path.basename(url.pathname);
      const file=url.pathname.startsWith('/group-workbench/')?path.join(web,name):path.join(root,name);
      if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type',{'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'}[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
    console.log('Synthetic read-only fixture ready: '+origin);
    browser=await chromium.launch({headless:true,timeout:120000,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    const login=await open();
    await login.locator('#identityMode').selectOption('multi');
    const multiOptions=await options(login,'#identityGroup');
    check('login has newcomer alongside all 12 existing multi groups',multiOptions.length===13&&multiOptions.filter(x=>x.value===groupId&&x.label===groupName).length===1);
    await login.locator('#identityGroup').selectOption(groupId);
    check('newcomer can be selected for worker entry',await login.locator('#identityGroup').inputValue()===groupId);
    check('multi login help names newcomer group',/新人组/.test(await login.locator('#identityGroupHelp').textContent()));
    await login.locator('#identityMode').selectOption('single');
    const singleOptions=await options(login,'#identityGroup');
    check('single login retains four active groups and excludes newcomer',singleOptions.length===4&&!singleOptions.some(x=>x.value===groupId));
    await bounded(login.context().close());
    const admin=await open({name:'admin',role:'admin'});
    check('prod81 candidate is loaded',await admin.evaluate(()=>window.GroupWorkbench.version)==='20261026-prod81');
    await admin.locator('[data-mode="multi"]').click();
    check('admin multi import offers all 13 groups',(await options(admin,'#dispatchForm select[name="group"]')).length===13);
    await admin.locator('#dispatchForm select[name="group"]').selectOption(groupId);
    await admin.locator('#dispatchForm input[name="movie"]').fill('新人组待导入影片');
    await admin.locator('#dispatchText').fill('NEWCOMER_IMPORT_001');
    await admin.locator('#dispatchPreviewBtn').click();
    check('newcomer import preview resolves correct mode and group',(await admin.locator('#dispatchPreview').textContent()).includes(groupName)&&!(await admin.locator('#dispatchCommitBtn').isDisabled()));
    await admin.screenshot({path:path.join(out,'newcomer-import.png'),fullPage:false});
    await admin.locator('nav [data-view="overview"]').click();
    check('multi overview lists newcomer as a peer row',await admin.locator(`#groupProgressBody tr[data-group-id="${groupId}"]`).count()===1&&await admin.locator('#groupProgressBody tr[data-group-id]').count()===13);
    check('multi filter includes newcomer once',(await options(admin,'#scopeGroup')).filter(x=>x.value===groupId&&x.label===groupName).length===1);
    await admin.locator('#scopeGroup').selectOption(groupId);
    check('newcomer overview counts only its three TIDs',await admin.locator('#metricTotal').textContent()==='3');
    check('newcomer overview keeps only selected group row',await admin.locator('#groupProgressBody tr[data-group-id]').count()===1);
    await admin.screenshot({path:path.join(out,'newcomer-overview.png'),fullPage:true});
    await admin.locator('nav [data-view="records"]').click();await admin.locator('#recordStatusBoard [data-status="all"]').click();
    const recordText=await admin.locator('#recordBody').textContent();
    check('all-task filter shows newcomer name and excludes other groups',recordText.includes(groupName)&&recordText.includes('M_NEWCOMER-SUBMIT')&&!recordText.includes('G06-')&&!recordText.includes('G01-'));
    const reports=await admin.evaluate(()=>window.GroupWorkbench.reports());
    check('real Reports tasks and groups label newcomer correctly',reports.tasks.rows.length===3&&reports.tasks.rows.every(row=>row.group===groupName)&&reports.groups.rows.length===1&&reports.groups.rows[0].group===groupName);
    await admin.locator('[data-mode="single"]').click();
    check('single admin scope excludes multi newcomer',!(await options(admin,'#scopeGroup')).some(x=>x.value===groupId));
    await admin.locator('nav [data-view="dispatch"]').click();
    check('single import does not offer newcomer',(await options(admin,'#dispatchForm select[name="group"]')).length===4);
    await admin.locator('[data-mode="multi"]').click();
    check('mode switching preserves newcomer import draft',await admin.locator('#dispatchForm select[name="group"]').inputValue()===groupId&&await admin.locator('#dispatchText').inputValue()==='NEWCOMER_IMPORT_001');
    for(const role of ['annotation','qc']){
      const worker=await open({name:'合成人员',role,groupId,mode:'multi'});
      check(`${role}: newcomer identity is accepted`,(await worker.locator('#currentUserLabel').textContent()).includes(groupName));
      check(`${role}: own newcomer group is locked`,await worker.locator('#scopeGroup').isDisabled()&&(await options(worker,'#scopeGroup')).length===1&&await worker.locator('#scopeGroup').inputValue()===groupId);
      check(`${role}: admin import and mode switch remain hidden`,!(await worker.locator('nav [data-view="dispatch"]').isVisible())&&!(await worker.locator('#modeSwitcher').isVisible()));
      if(role==='annotation'){
        check('annotation: own pending task visible without same-name other-group tasks',(await worker.locator('#myTasksBody').textContent()).includes('M_NEWCOMER-CLAIM')&&!(await worker.locator('#myTasksBody').textContent()).includes('G06-'));
        await worker.locator('#taskSearchInput').fill('G06-FREE');await worker.locator('#taskSearchForm button').click();
        await worker.waitForFunction(()=>/自己小组|未找到完整 TID/.test(document.getElementById('toast').textContent));
        check('annotation: cross-group TID claim rejected before any transaction',/自己小组|未找到完整 TID/.test(await worker.locator('#toast').textContent())&&businessWrites.length===0);
      }else{
        await worker.locator('#qcTaskFilter').selectOption('review');
        check('QC: review queue contains only newcomer submitted task',await worker.locator('#qcQueueBody input[name="qcTask"]').count()===1&&(await worker.locator('#qcQueueBody').textContent()).includes('M_NEWCOMER-SUBMIT'));
      }
      await worker.locator('nav [data-view="overview"]').click();
      await worker.locator('#scopeGroup').evaluate(select=>{select.innerHTML+='<option value="g06">其他组</option>';select.disabled=false;select.value='g06';select.dispatchEvent(new Event('change',{bubbles:true}));});
      check(`${role}: forged group selector cannot expose other-group totals`,await worker.locator('#metricTotal').textContent()==='3');
      const visible=await worker.evaluate(()=>window.GroupWorkbench.reports().tasks.rows);
      check(`${role}: reports remain own-group despite forged scope`,visible.length===3&&visible.every(row=>row.group===groupName));
      await bounded(worker.context().close());
    }
    const existing=await open({name:'合成人员',role:'qc',groupId:'g06',mode:'multi'});
    await existing.locator('#qcTaskFilter').selectOption('review');
    check('existing group QC session stays valid and cannot see newcomer tasks',await existing.locator('#scopeGroup').inputValue()==='g06'&&(await existing.locator('#qcQueueBody').textContent()).includes('G06-SUBMIT')&&!(await existing.locator('#qcQueueBody').textContent()).includes('M_NEWCOMER'));
    await bounded(existing.context().close());
    const app=fs.readFileSync(path.join(web,'app.js'),'utf8');
    const groups=new Function(app.slice(app.indexOf('  const GROUPS = ['),app.indexOf('  const QC_TAGS ='))+'return GROUPS;')();
    for(const role of ['admin','qc']){
      const profile=role==='admin'?{role,name:'admin'}:{role,name:'合成人员',groupId,mode:'multi'};
      for(const kind of ['tasks','groups','daily','personDaily']){
        const result=createExporter(Flow,Reports,IO).generate({kind,scope:{profile,mode:'multi',groupId,range:'all'},groups,statusMeta:Flow.STATUS_META,eventLabels:{}},state,null);
        const csv=await result.blob.text();
        check(`${role}: actual export worker ${kind} resolves newcomer label without leaking original group`,csv.includes(groupName)&&!csv.includes('多镜头1组')&&!csv.includes('未知小组'));
      }
    }
    check('synthetic source is not mutated',JSON.stringify(state)===sourceBefore);
    check('no production request or business mutation',businessWrites.length===0&&errors.length===0);
    assert.deepEqual(hashFiles(),manifest);check('frozen source hashes remain exact',true);
  }catch(error){failure=error;errors.push(error.stack||String(error));}
  finally{
    for(const context of contexts)await bounded(context.close().catch(()=>{}));
    if(browser)await bounded(browser.close().catch(()=>{}));
    if(server){server.closeAllConnections();await bounded(new Promise(resolve=>server.close(resolve)));}
    const result={ok:!failure,checks,errors,sourceHashes:hashFiles(),syntheticOnly:true,productionBusinessWrites:0,blockedMutations:businessWrites};
    fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:result.ok,checks:checks.length,errors}));
  }
  if(failure)throw failure;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
