'use strict';
// Real Chromium, isolated local fixture only. Run acceptance-sampling-browser-server.cjs first.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fork}=require('node:child_process');
const {createHash}=require('node:crypto');
const {chromium}=require('C:/Users/yeddashang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const Reports=require('../group-workbench/reports.js');
const port=Number(process.env.SAMPLING_TEST_PORT||43188),origin=`http://127.0.0.1:${port}`,out=path.resolve(__dirname,'../../browser');
fs.mkdirSync(out,{recursive:true});
const checks=[],errors=[],check=(label,value)=>{assert(value,label);checks.push(label);console.log('PASS '+label);};
async function state(){return fetch(origin+'/__test/state').then(r=>r.json());}
async function action(body){const r=await fetch(origin+'/__test/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200,await r.clone().text());return r.json();}
async function login(profile){const r=await fetch(origin+'/group-workbench-api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile,pin:profile.role==='annotation'?undefined:'isolated-test-group-pin'})});assert.equal(r.status,200,await r.clone().text());return r.json();}
async function contextFor(browser,profile,legacy=false){
  console.log('OPEN '+profile.name+(legacy?' legacy':' candidate'));
  const auth=await login(profile),context=await browser.newContext({viewport:{width:1520,height:1050},timezoneId:'Asia/Shanghai'});
  await context.addInitScript(value=>{if(location.hostname==='127.0.0.1')sessionStorage.setItem('r2v-group-workbench-shared-v1:session',JSON.stringify(value));},auth);
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+(legacy?'/legacy/group-workbench/':'/group-workbench/'));
  await page.locator('#appShell').waitFor({state:'visible'});return {page,context,auth};
}
async function acceptance(page){await page.locator('nav [data-view="acceptance"]').click();await page.locator('#acceptanceView').waitFor({state:'visible'});}
async function movie(page,title){
  if(await page.locator('#acceptanceClearFilters').isEnabled())await page.locator('#acceptanceClearFilters').click();
  await page.locator('#acceptanceMovie').click();await page.locator('#multiSelectLayer').getByText(title,{exact:true}).click();await page.locator('#multiSelectLayer .multi-select-search').press('Escape');
}
async function sample(page,prefix,count,actionType){
  console.log('SAMPLE '+prefix+' '+actionType);
  await page.locator('#acceptanceSelectAllButton').click();await page.locator('#acceptanceSampleBatch').click();
  await page.locator('#acceptanceSampleForm').waitFor({state:'visible'});
  await page.locator('#acceptanceSampleForm [name="inspectedTids"]').fill(Array.from({length:count},(_,i)=>`${prefix}-${String(i+1).padStart(3,'0')}`).join('\n'));
  await page.locator('#acceptanceSampleForm [name="failedTids"]').fill(`${prefix}-009\n${prefix}-010`);
  await page.locator(`#acceptanceSampleForm [name="batchAction"][value="${actionType}"]`).check();
  await page.locator('#acceptanceSampleForm [name="failureNote"]').fill('合成实检问题：主体遗漏，请修正这两条。');
  await page.locator('#acceptanceSampleForm [name="note"]').fill('合成整批处理说明：按当前固定名单处理。');
}
async function main(){
  const fixture=fork(path.join(__dirname,'acceptance-sampling-browser-server.cjs'),[],{silent:true,env:{...process.env,SAMPLING_TEST_PORT:String(port)}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Local fixture startup timed out')),15000);fixture.stdout.once('data',chunk=>{clearTimeout(timer);console.log(String(chunk).trim());resolve();});fixture.once('exit',code=>{clearTimeout(timer);reject(new Error('Local fixture exited '+code));});fixture.stderr.on('data',chunk=>process.stderr.write(chunk));});
  console.log('LAUNCH Chromium');
  const browser=await chromium.launch({headless:true,timeout:30000,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try{
    const {page}=await contextFor(browser,{name:'测试验收',role:'acceptance',groupId:'g01',mode:'single'});
    const oldAnnotation=await contextFor(browser,{name:'旧页标注',role:'annotation',groupId:'g01',mode:'single'},true);
    await oldAnnotation.page.locator('nav [data-view="tasks"]').click();
    await oldAnnotation.page.locator('#annotationBulkTids').fill('LEGACY-ANNOTATION');
    const oldAcceptance=await contextFor(browser,{name:'旧页验收',role:'acceptance',groupId:'g01',mode:'single'},true);
    await acceptance(oldAcceptance.page);await oldAcceptance.page.locator('#acceptanceImportDetails').evaluate(el=>el.open=true);
    await oldAcceptance.page.locator('#acceptanceText').fill('LEGACY-001');
    await oldAcceptance.page.locator('#acceptancePreviewBtn').click();await oldAcceptance.page.locator('#acceptanceChoice input[value="acceptance_pass"]').check();
    await oldAcceptance.page.locator('#acceptanceChoiceNote').fill('旧页草稿保留');
    await acceptance(page);await movie(page,'整批退回测试');
    check('pending queue has the original 100 only',await page.locator('#acceptanceQueueCount').innerText()==='100');
    await sample(page,'RETURN',10,'return');
    check('fixed list renders at most 50 preview rows',await page.locator('.acceptance-sample-members tbody tr').count()===50);
    const preview=await page.locator('.acceptance-sample-preview').innerText();
    check('100 / 8 / 2 / 90 summary is explicit',preview.includes('实检合格 8')&&preview.includes('实检不合格 2')&&preview.includes('未实检 90')&&preview.includes('退回质检 100'));
    await page.locator('#acceptanceSampleForm').screenshot({path:path.join(out,'sampling-return-panel.png')});
    await action({action:'arrive'});await page.locator('#sharedRefreshBtn').click();
    check('new arrival does not expand the frozen list',(await page.locator('#acceptanceSampleForm h3').innerText()).includes('100'));
    await page.locator('#acceptanceSampleForm button[type="submit"]').click();await page.locator('#acceptanceSampleForm').waitFor({state:'detached'});
    let value=await state(),returned=value.tasks.filter(t=>t.tid.startsWith('RETURN-'));
    check('one operation returns all original 100',returned.length===100&&returned.every(t=>t.status==='acceptance_return_pending'));
    check('quality is 8 pass, 2 fail, 90 uninspected',returned.filter(t=>t.acceptanceInspection==='pass').length===8&&returned.filter(t=>t.acceptanceInspection==='fail').length===2&&returned.filter(t=>t.acceptanceInspection==='uninspected').length===90);
    check('arrival and already accepted task remain unchanged',value.tasks.find(t=>t.tid==='ARRIVAL-001').status==='pending_acceptance'&&value.tasks.find(t=>t.tid==='DONE-001').status==='accepted');
    const metric=Reports.acceptanceAccuracy({tasks:returned,events:value.state.events});
    check('real saved first inspection accuracy equals 80 percent',metric.passed===8&&metric.total===10&&metric.rate===80);
    await movie(page,'随批放行测试');await sample(page,'PASS',10,'pass');
    check('follow pass summary includes 98 accepted and 2 returned',(await page.locator('.acceptance-sample-preview').innerText()).includes('验收通过 98'));
    await page.locator('#acceptanceSampleForm button[type="submit"]').click();await page.locator('#acceptanceSampleForm').waitFor({state:'detached'});
    value=await state();const passed=value.tasks.filter(t=>t.tid.startsWith('PASS-'));
    check('follow pass leaves real failures in QC',passed.filter(t=>t.status==='accepted').length===98&&passed.filter(t=>t.status==='acceptance_return_pending'&&t.acceptanceInspection==='fail').length===2);
    await movie(page,'草稿冲突测试');await page.locator('#acceptanceSelectAllButton').click();await page.locator('#acceptanceSampleBatch').click();
    const form=page.locator('#acceptanceSampleForm');
    await form.locator('[name="batchAction"][value="return"]').check();await form.locator('[name="note"]').fill('发生冲突也保留此说明');
    await form.locator('[name="failedTids"]').fill('DRAFT-001');
    check('failed subset outside inspected list blocks saving',await form.locator('button[type="submit"]').isDisabled()&&(await form.locator('.acceptance-sample-preview').innerText()).includes('必须先列入'));
    await form.locator('[name="failedTids"]').fill('');await form.locator('[name="inspectedTids"]').fill('RETURN-001');
    check('TID outside fixed list blocks saving',await form.locator('button[type="submit"]').isDisabled());
    await form.locator('[name="inspectedTids"]').fill('');
    check('empty inspection list clearly says no quality results',(await form.locator('.acceptance-sample-preview').innerText()).includes('本次没有实检结果'));
    await action({action:'edit',tid:'DRAFT-002'});const before=(await state()).revision;
    await form.locator('button[type="submit"]').click();await page.waitForFunction(()=>document.getElementById('acceptanceSampleForm')&&!document.querySelector('#acceptanceSampleForm button[type="submit"]').disabled);
    check('stale member blocks the entire batch',(await state()).revision===before);
    check('conflict retains fixed members and draft',await form.locator('[name="note"]').inputValue()==='发生冲突也保留此说明'&&(await form.locator('h3').innerText()).includes('3'));
    await form.screenshot({path:path.join(out,'sampling-conflict-draft.png')});
    const multi=await contextFor(browser,{name:'多镜验收',role:'acceptance',groupId:'g06',mode:'multi'});
    await acceptance(multi.page);check('multi mode shows only 10 multi tasks',await multi.page.locator('#acceptanceQueueCount').innerText()==='10');
    await sample(multi.page,'MULTI',10,'pass');await multi.page.locator('#acceptanceSampleForm button[type="submit"]').click();await multi.page.locator('#acceptanceSampleForm').waitFor({state:'detached'});
    value=await state();check('multi pass is isolated from single mode',value.tasks.filter(t=>t.tid.startsWith('MULTI-')&&t.status==='accepted').length===8&&value.tasks.filter(t=>t.tid.startsWith('DRAFT-')&&t.status==='pending_acceptance').length===3);
    check('old annotation page retained its unsubmitted TID',await oldAnnotation.page.locator('#annotationBulkTids').inputValue()==='LEGACY-ANNOTATION');
    await oldAnnotation.page.locator('#annotationBulkComplete').click();
    await oldAnnotation.page.waitForFunction(()=>document.getElementById('annotationBulkResult').textContent.includes('1'));
    check('old annotation page can still submit on new API',(await state()).tasks.find(t=>t.tid==='LEGACY-ANNOTATION').status==='pending_qc');
    check('old acceptance page retained its note',await oldAcceptance.page.locator('#acceptanceChoiceNote').inputValue()==='旧页草稿保留');
    await oldAcceptance.page.locator('#acceptanceCommitBtn').click();await oldAcceptance.page.waitForFunction(()=>document.getElementById('acceptanceImportFeedback').textContent.includes('成功'));
    check('old acceptance page can still submit without new metadata',(await state()).tasks.find(t=>t.tid==='LEGACY-001').status==='accepted');
    const capability=await contextFor(browser,{name:'版本验收',role:'acceptance',groupId:'g01',mode:'single'});
    await acceptance(capability.page);await movie(capability.page,'旧验收页兼容');await capability.page.locator('#acceptanceSelectAllButton').click();await capability.page.locator('#acceptanceSampleBatch').click();
    await capability.page.locator('#acceptanceSampleForm [name="batchAction"][value="pass"]').check();await capability.page.locator('#acceptanceSampleForm [name="note"]').fill('版本检查失败仍保留');
    await action({action:'health',supported:false});const revision=(await state()).revision;
    await capability.page.locator('#acceptanceSampleForm button[type="submit"]').click();await capability.page.waitForFunction(()=>document.getElementById('acceptanceSampleForm')&&!document.querySelector('#acceptanceSampleForm button[type="submit"]').disabled);
    check('unsupported API never receives a downgraded transaction',(await state()).revision===revision);
    check('unsupported API preserves draft',await capability.page.locator('#acceptanceSampleForm [name="note"]').inputValue()==='版本检查失败仍保留');
    await action({action:'health',supported:true});
    await capability.page.locator('#acceptanceSampleForm button[type="submit"]').click();await capability.page.locator('#acceptanceSampleForm').waitFor({state:'detached'});
    check('capability failure can be retried without reentry',(await state()).tasks.find(t=>t.tid==='LEGACY-002').status==='accepted');
    await page.locator('#scopeGroup').selectOption('g01');await page.locator('[data-date-preset="all"]').click();
    const workerUrls=[];page.on('request',request=>{if(request.url().includes('export-worker'))workerUrls.push(request.url());});
    const beforeExport=(await state()).revision;
    for(const [kind,file]of [['acceptanceAccuracy','real-worker-accuracy.csv'],['acceptanceHistory','real-worker-history.csv']]){
      console.log('EXPORT '+kind);
      await page.locator('#acceptanceExportMenu summary').click();
      const downloaded=page.waitForEvent('download',{timeout:20000});
      await page.locator(`#acceptanceExportMenu [data-export="${kind}"]`).first().click();
      const download=await downloaded;await download.saveAs(path.join(out,file));
      const csv=fs.readFileSync(path.join(out,file),'utf8');
      if(kind==='acceptanceAccuracy')check('actual worker denominator CSV includes inspected pass/fail only',csv.includes('RETURN-001')&&csv.includes('RETURN-010')&&!csv.includes('RETURN-011')&&!csv.includes('PASS-011'));
      else check('actual worker history CSV preserves uninspected batch decisions',csv.includes('RETURN-011')&&csv.includes('PASS-011')&&csv.includes('未实检'));
    }
    check('real worker exports do not change task state',(await state()).revision===beforeExport);
    check('prod74 worker loads in the actual browser',workerUrls.some(url=>/export-worker\.20261020-prod74/.test(url)));
    check('no browser JavaScript errors',errors.length===0);
    const packaged=process.env.SAMPLING_TEST_PACKAGED==='1',packageDir=path.resolve(__dirname,'../../package/static');
    const sourceHashes=packaged?Object.fromEntries(fs.readdirSync(packageDir).filter(name=>/\.(?:js|css|html)$/.test(name)).map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(packageDir,name))).digest('hex')])):{};
    const report={ok:true,checks,errors,workerUrls,packaged,sourceHashes,syntheticOnly:true,productionBusinessWrites:0};fs.writeFileSync(path.join(out,packaged?'sampling-browser-packaged.json':'sampling-browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }finally{await browser.close();fixture.kill();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
