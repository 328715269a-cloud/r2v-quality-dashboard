'use strict';
// Synthetic loopback-only fixture; verifies the exact packaged frontend in real Chromium.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fork}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const {chromium}=require('C:/Users/yeddashang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const Reports=require('../group-workbench/reports.js');
const port=Number(process.env.BATCH_RETURN_TEST_PORT||43189),origin=`http://127.0.0.1:${port}`;
const out=path.resolve(__dirname,'../../browser'),packageDir=path.resolve(__dirname,'../../package/static');
const checks=[],errors=[],check=(label,value)=>{assert(value,label);checks.push(label);console.log('PASS '+label);};
const single={name:'测试验收',role:'acceptance',groupId:'g01',mode:'single'};
const multi={name:'多镜验收',role:'acceptance',groupId:'g06',mode:'multi'};
const pinFor=profile=>profile.role==='annotation'?undefined:profile.role==='admin'?'isolated-test-admin-pin':'isolated-test-group-pin';
async function json(url,body,headers={}) {
  const response=await fetch(origin+url,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{...(body?{'Content-Type':'application/json'}:{}),...headers}});
  assert.equal(response.status,200,await response.clone().text());return response.json();
}
const state=()=>json('/__test/state');
const action=body=>json('/__test/action',body);
const login=profile=>json('/group-workbench-api/session',{profile,pin:pinFor(profile)});
async function tx(profile,delta){
  const auth=await login(profile);
  return json('/group-workbench-api/transactions',{id:randomUUID(),revision:(await state()).revision,delta,...(profile.role==='admin'?{pin:pinFor(profile)}:{})},{'X-Workbench-Session':auth.token});
}
async function seedSecondGroup(){
  const batch={id:'batch_'+randomUUID(),date:'2026-10-20',groupId:'g02',mode:'single',movie:'另一组统一复查测试'};
  const task={id:'task_'+randomUUID(),tid:'GROUP2-001',date:batch.date,groupId:batch.groupId,mode:batch.mode,movie:batch.movie,batchId:batch.id};
  const event=(type,extra={})=>({id:'event_'+randomUUID(),taskId:task.id,type,workflowVersion:3,...extra});
  batch.taskIds=[task.id];
  await tx({name:'admin',role:'admin'},{tasks:[task],batches:[batch],events:[event('dispatch')]});
  await tx({name:'另一组标注',role:'annotation',groupId:'g02',mode:'single'},{events:[event('claim'),event('submit',{round:1})]});
  await tx({name:'另一组组长',role:'qc',groupId:'g02',mode:'single'},{events:[event('qc_pass',{qcRound:1})]});
}
async function open(browser,profile){
  const auth=await login(profile),context=await browser.newContext({viewport:{width:1540,height:1050},timezoneId:'Asia/Shanghai'});
  await context.addInitScript(value=>{if(location.hostname==='127.0.0.1')sessionStorage.setItem('r2v-group-workbench-shared-v1:session',JSON.stringify(value));},auth);
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/group-workbench/');
  await page.locator('#appShell').waitFor({state:'visible'});
  await page.locator('nav [data-view="acceptance"]').click();
  await page.locator('#acceptanceView').waitFor({state:'visible'});
  return page;
}
async function finder(page,tids,choice='acceptance_batch_return',note=''){
  await page.locator('#acceptanceImportDetails').evaluate(el=>el.open=true);
  await page.locator('#acceptanceText').fill(tids.join('\n'));
  await page.locator('#acceptancePreviewBtn').click();
  await page.waitForFunction(()=>!document.getElementById('acceptancePreviewBtn').disabled&&!!document.querySelector('#acceptancePreview .import-result'));
  await page.locator(`#acceptanceChoice [value="${choice}"]`).check();
  await page.locator('#acceptanceChoiceNote').fill(note);
}
async function saveFinder(page){
  await page.locator('#acceptanceCommitBtn').click();
  await page.waitForFunction(()=>document.getElementById('acceptanceCommitBtn').textContent!=='正在保存…');
}
async function movie(page,title){
  if(await page.locator('#acceptanceClearFilters').isEnabled())await page.locator('#acceptanceClearFilters').click();
  await page.locator('#acceptanceMovie').click();
  await page.locator('#multiSelectLayer').getByText(title,{exact:true}).click();
  await page.locator('#multiSelectLayer .multi-select-search').press('Escape');
}
async function toolbar(page,title,note=''){
  await movie(page,title);await page.locator('#acceptanceSelectAllButton').click();
  await page.locator('#acceptanceBulkReturn').click();
  await page.locator('#acceptanceBulkDecisionForm').waitFor({state:'visible'});
  await page.locator('#acceptanceBulkDecisionForm [name="note"]').fill(note);
}
function decisions(value,tids){
  const ids=new Set(value.tasks.filter(task=>tids.includes(task.tid)).map(task=>task.id));
  return value.state.events.filter(event=>ids.has(event.taskId)&&['acceptance_pass','acceptance_fail'].includes(event.type));
}
function accuracy(value,tids){
  return Reports.acceptanceAccuracy({tasks:value.tasks.filter(task=>tids.includes(task.tid)),events:value.state.events});
}
async function main(){
  fs.mkdirSync(out,{recursive:true});
  const fixture=fork(path.join(__dirname,'acceptance-sampling-browser-server.cjs'),[],{silent:true,env:{...process.env,SAMPLING_TEST_PORT:String(port),SAMPLING_TEST_PACKAGED:'1'}});
  let browser;
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture startup timeout')),20000);fixture.stdout.once('data',chunk=>{clearTimeout(timer);console.log(String(chunk).trim());resolve();});fixture.once('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exit '+code));});fixture.stderr.on('data',chunk=>process.stderr.write(chunk));});
    await seedSecondGroup();
    browser=await chromium.launch({headless:true,timeout:30000,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    const page=await open(browser,single);
    check('exact packaged prod75 entry is loaded',await page.locator('script[src*="app.20261020-prod75"]').count()===1);
    await finder(page,['UNKNOWN-BATCH-RETURN','DONE-001']);
    const invalid=await page.locator('#acceptancePreview').innerText();
    check('unknown and already processed TIDs are rejected',invalid.includes('尚未导入')&&invalid.includes('不可登记')&&await page.locator('#acceptanceCommitBtn').isDisabled());
    await finder(page,['RETURN-001','RETURN-002']);
    check('Finder exposes unified batch return and empty note is allowed',await page.locator('#acceptanceCommitBtn').isEnabled()&&(await page.locator('#acceptanceCommitBtn').innerText()).includes('确认整批退回 2 条'));
    await page.locator('#acceptanceImportDetails').screenshot({path:path.join(out,'batch-return-finder.png')});
    await saveFinder(page);
    let value=await state(),events=decisions(value,['RETURN-001','RETURN-002']);
    check('single Finder saves one fixed uninspected batch',events.length===2&&events.every(event=>event.type==='acceptance_fail'&&event.acceptanceInspection==='uninspected'&&event.note.includes('整批退回，统一复查'))&&new Set(events.map(event=>event.acceptanceBatchId)).size===1&&!!events[0].acceptanceBatchId);
    check('uninspected returns do not enter first accuracy',accuracy(value,['RETURN-001','RETURN-002']).total===0);
    check('uninspected return tasks move to QC and retain marker',value.tasks.filter(task=>['RETURN-001','RETURN-002'].includes(task.tid)).every(task=>task.status==='acceptance_return_pending'&&task.acceptanceInspection==='uninspected'));
    check('already accepted task remains untouched',value.tasks.find(task=>task.tid==='DONE-001').status==='accepted');
    await finder(page,['RETURN-003'],'acceptance_fail');
    check('ordinary actual failure still requires an explanation',await page.locator('#acceptanceCommitBtn').isDisabled());
    await page.locator('#acceptanceChoiceNote').fill('实际检查发现主体缺失');await saveFinder(page);
    value=await state();
    check('ordinary failure remains an actual quality failure',decisions(value,['RETURN-003']).every(event=>event.acceptanceInspection==='fail'&&!event.acceptanceBatchId)&&accuracy(value,['RETURN-003']).total===1&&accuracy(value,['RETURN-003']).passed===0);
    await finder(page,['RETURN-004','GROUP2-001']);
    const beforeMixed=(await state()).revision;
    if(await page.locator('#acceptanceCommitBtn').isEnabled())await saveFinder(page);
    check('mixed groups cannot be silently returned together',(await state()).revision===beforeMixed&&/一个小组|同一小组|同组/.test(await page.locator('body').innerText()));
    await finder(page,['DRAFT-001','DRAFT-002'],'acceptance_batch_return','冲突以后保留此说明');
    await action({action:'edit',tid:'DRAFT-002'});const beforeConflict=(await state()).revision;
    await saveFinder(page);value=await state();
    check('Finder conflict writes no partial batch',value.revision===beforeConflict&&decisions(value,['DRAFT-001','DRAFT-002']).length===0);
    check('Finder conflict preserves TIDs choice and note',await page.locator('#acceptanceText').inputValue()==='DRAFT-001\nDRAFT-002'&&await page.locator('#acceptanceChoice [value="acceptance_batch_return"]').isChecked()&&await page.locator('#acceptanceChoiceNote').inputValue()==='冲突以后保留此说明');
    await toolbar(page,'旧验收页兼容');
    check('toolbar has the same unified return operation',/整批退回|统一复查/.test(await page.locator('#acceptanceBulkDecisionForm').innerText())&&await page.locator('#acceptanceBulkDecisionForm button[type="submit"]').isEnabled());
    const toolbarBefore=(await state()).revision;
    if(await page.locator('#acceptanceCommitBtn').isEnabled())await saveFinder(page);
    check('a frozen toolbar operation blocks Finder submission',(await state()).revision===toolbarBefore);
    await action({action:'arrive'});await page.locator('#sharedRefreshBtn').click();
    check('new arrivals do not enlarge the toolbar frozen list',(await page.locator('#acceptanceBulkDecisionForm h3').innerText()).includes('2'));
    await page.locator('#acceptanceBulkDecisionForm button[type="submit"]').click();await page.locator('#acceptanceBulkDecisionForm').waitFor({state:'detached'});
    value=await state();events=decisions(value,['LEGACY-001','LEGACY-002']);
    check('toolbar saves exactly its fixed members as uninspected',events.length===2&&events.every(event=>event.acceptanceInspection==='uninspected'&&event.note.includes('统一复查'))&&new Set(events.map(event=>event.acceptanceBatchId)).size===1&&accuracy(value,['LEGACY-001','LEGACY-002']).total===0);
    check('new arrival remains pending',value.tasks.find(task=>task.tid==='ARRIVAL-001').status==='pending_acceptance');
    await toolbar(page,'草稿冲突测试','保留工具栏复查说明');
    await action({action:'edit',tid:'DRAFT-003'});const beforeToolbarConflict=(await state()).revision;
    await page.locator('#acceptanceBulkDecisionForm button[type="submit"]').click();
    await page.waitForFunction(()=>!!document.querySelector('#acceptanceBulkDecisionForm button[type="submit"]:not(:disabled)'));
    value=await state();
    check('toolbar conflict is all-or-none and keeps draft',value.revision===beforeToolbarConflict&&decisions(value,['DRAFT-001','DRAFT-003']).length===0&&await page.locator('#acceptanceBulkDecisionForm [name="note"]').inputValue()==='保留工具栏复查说明');
    const multiPage=await open(browser,multi);
    await finder(multiPage,['MULTI-001','MULTI-002']);
    check('multi Finder also exposes empty-note unified return',await multiPage.locator('#acceptanceCommitBtn').isEnabled());
    await saveFinder(multiPage);value=await state();events=decisions(value,['MULTI-001','MULTI-002']);
    check('multi unified return is isolated and excludes quality',events.length===2&&events.every(event=>event.acceptanceInspection==='uninspected')&&accuracy(value,['MULTI-001','MULTI-002']).total===0&&value.tasks.find(task=>task.tid==='RETURN-004').status==='pending_acceptance');
    await finder(multiPage,['MULTI-003'],'acceptance_pass');await saveFinder(multiPage);
    value=await state();
    check('actual acceptance pass still counts normally',value.tasks.find(task=>task.tid==='MULTI-003').status==='accepted'&&accuracy(value,['MULTI-003']).passed===1);
    check('browser JavaScript stays error-free',errors.length===0);
    const sourceHashes=Object.fromEntries(fs.readdirSync(packageDir).filter(name=>/\.(?:js|css|html)$/.test(name)).map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(packageDir,name))).digest('hex')]));
    const report={ok:true,checks,errors,packaged:true,sourceHashes,syntheticOnly:true,productionBusinessWrites:0};
    fs.writeFileSync(path.join(out,'batch-return-browser-packaged.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }finally{if(browser)await browser.close();fixture.kill();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
