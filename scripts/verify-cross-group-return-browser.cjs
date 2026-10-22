'use strict';
// Real Chrome against the existing loopback-only API fixture. All tasks below
// are synthetic; external browser requests are blocked. No production writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fork}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const {chromium}=require('C:/Users/yeddashang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const Reports=require('../group-workbench/reports.js');
const port=Number(process.env.CROSS_GROUP_RETURN_TEST_PORT||43195),origin=`http://127.0.0.1:${port}`;
const out=path.resolve(__dirname,'../../cross-group-return'),packageDir=path.resolve(__dirname,'../../package/static');
const expectedApp='app.20261022-prod78-cross-group-return.js';
const checks=[],errors=[],transactionRequests=[],snapshots=[];
const check=(label,value)=>{assert(value,label);checks.push(label);console.log('PASS '+label);};
const profiles={single:{name:'测试验收',role:'acceptance',groupId:'g01',mode:'single'},multi:{name:'多镜验收',role:'acceptance',groupId:'g06',mode:'multi'}};
const pinFor=profile=>profile.role==='annotation'?undefined:profile.role==='admin'?'isolated-test-admin-pin':'isolated-test-group-pin';
async function json(url,body,headers={}) {
  const response=await fetch(origin+url,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{...(body?{'Content-Type':'application/json'}:{}),...headers}});
  assert.equal(response.status,200,await response.clone().text());return response.json();
}
const state=()=>json('/__test/state'),action=body=>json('/__test/action',body);
const authCache=new Map();
async function login(profile){const key=JSON.stringify(profile);if(!authCache.has(key))authCache.set(key,await json('/group-workbench-api/session',{profile,pin:pinFor(profile)}));return authCache.get(key);}
async function tx(profile,delta){
  const auth=await login(profile);
  return json('/group-workbench-api/transactions',{id:randomUUID(),revision:(await state()).revision,delta,...(profile.role==='admin'?{pin:pinFor(profile)}:{})},{'X-Workbench-Session':auth.token});
}
async function seedCases(){
  const cases={},tasks=[],batches=[];
  const event=(task,type,extra={})=>({id:'event_'+randomUUID(),taskId:task.id,type,workflowVersion:3,...extra});
  for(const mode of ['single','multi']){
    const prefix=mode==='single'?'S':'M',label=mode==='single'?'单镜':'多镜',groups=mode==='single'?['g01','g02']:['g06','g07'];cases[mode]={};
    for(const [key,code,title]of [['finder','F','粘贴'],['toolbar','T','列表'],['finderConflict','FC','粘贴冲突'],['toolbarConflict','TC','列表冲突']]){
      const pair={movie:`跨组${label}${title}`,mode,tids:[]};cases[mode][key]=pair;
      groups.forEach((groupId,groupIndex)=>{
        const batch={id:'batch_'+randomUUID(),date:'2026-10-20',groupId,mode,movie:pair.movie,taskIds:[]};batches.push(batch);
        for(let index=1;index<=2;index++){
          const task={id:'task_'+randomUUID(),tid:`${prefix}${code}-${groupIndex===0?'A':'B'}-${String(index).padStart(3,'0')}`,date:batch.date,groupId,mode,movie:pair.movie,batchId:batch.id};
          tasks.push(task);pair.tids.push(task.tid);batch.taskIds.push(task.id);
        }
      });
    }
  }
  await tx({name:'admin',role:'admin'},{tasks,batches,events:tasks.map(task=>event(task,'dispatch'))});
  for(const groupId of ['g01','g02','g06','g07']){
    const members=tasks.filter(task=>task.groupId===groupId),mode=members[0].mode;
    await tx({name:['g01','g06'].includes(groupId)?'第一组标注':'第二组标注',role:'annotation',groupId,mode},{events:members.flatMap(task=>[event(task,'claim'),event(task,'submit',{round:1})])});
    await tx({name:'跨组测试组长',role:'qc',groupId,mode},{events:members.map(task=>event(task,'qc_pass',{qcRound:1}))});
  }
  console.log('Synthetic cross-group fixtures ready');return cases;
}
async function open(browser,profile){
  const auth=await login(profile),context=await browser.newContext({viewport:{width:1540,height:1050},timezoneId:'Asia/Shanghai'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();errors.push('Blocked non-local request '+route.request().url());return route.abort();});
  await context.addInitScript(value=>{if(location.hostname==='127.0.0.1')sessionStorage.setItem('r2v-group-workbench-shared-v1:session',JSON.stringify(value));},auth);
  const page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/group-workbench-api/transactions')transactionRequests.push({page:profile.mode,body:request.postDataJSON()});});
  await page.goto(origin+'/group-workbench/');await page.locator('#appShell').waitFor({state:'visible'});
  await page.locator('nav [data-view="acceptance"]').click();await page.locator('#acceptanceView').waitFor({state:'visible'});
  return page;
}
async function finder(page,tids,choice='acceptance_batch_return',note=''){
  await page.locator('#acceptanceImportDetails').evaluate(el=>el.open=true);
  await page.locator('#acceptanceText').fill(tids.join('\n'));await page.locator('#acceptancePreviewBtn').click();
  await page.waitForFunction(()=>!document.getElementById('acceptancePreviewBtn').disabled&&!!document.querySelector('#acceptancePreview .import-result'));
  await page.locator(`#acceptanceChoice [value="${choice}"]`).check();await page.locator('#acceptanceChoiceNote').fill(note);
}
async function saveFinder(page){
  await page.locator('#acceptanceCommitBtn').click();
  await page.waitForFunction(()=>document.getElementById('acceptanceCommitBtn').textContent!=='正在保存…');
}
async function selectMovie(page,title){
  if(await page.locator('#acceptanceClearFilters').isEnabled())await page.locator('#acceptanceClearFilters').click();
  await page.locator('#acceptanceMovie').click();await page.locator('#multiSelectLayer').getByText(title,{exact:true}).click();
  await page.locator('#multiSelectLayer .multi-select-search').press('Escape');
  await page.locator('#acceptanceSelectAllButton').click();
}
async function toolbar(page,pair,note=''){
  await selectMovie(page,pair.movie);await page.locator('#acceptanceBulkReturn').click();
  await page.locator('#acceptanceBulkDecisionForm').waitFor({state:'visible'});
  await page.locator('#acceptanceBulkDecisionForm [name="note"]').fill(note);
}
async function saveToolbar(page,success=true){
  await page.locator('#acceptanceBulkDecisionForm button[type="submit"]').click();
  if(success)await page.locator('#acceptanceBulkDecisionForm').waitFor({state:'detached'});
  else await page.waitForFunction(()=>!!document.querySelector('#acceptanceBulkDecisionForm button[type="submit"]:not(:disabled)'));
}
function selectedTasks(value,tids){return value.tasks.filter(task=>tids.includes(task.tid));}
function decisions(value,tids){
  const ids=new Set(selectedTasks(value,tids).map(task=>task.id));
  return value.state.events.filter(event=>ids.has(event.taskId)&&['acceptance_pass','acceptance_fail'].includes(event.type));
}
function accuracy(value,tids){return Reports.acceptanceAccuracy({tasks:selectedTasks(value,tids),events:value.state.events});}
async function assertSaved(label,pair,before,requestStart){
  const value=await state(),events=decisions(value,pair.tids),requests=transactionRequests.slice(requestStart);
  const old=new Map(selectedTasks(before,pair.tids).map(task=>[task.id,task]));
  check(`${label}: all selected members returned together`,events.length===pair.tids.length&&selectedTasks(value,pair.tids).every(task=>task.status==='acceptance_return_pending'));
  check(`${label}: original group, assignee and mode are preserved`,selectedTasks(value,pair.tids).every(task=>task.groupId===old.get(task.id).groupId&&task.assignee===old.get(task.id).assignee&&task.mode===old.get(task.id).mode)&&new Set(selectedTasks(value,pair.tids).map(task=>task.groupId)).size===2);
  check(`${label}: one atomic transaction for all groups`,requests.length===1&&value.revision===before.revision+1&&requests[0].body.delta.events.length===pair.tids.length);
  check(`${label}: common batch ID and explicit uninspected return`,events.every(event=>event.type==='acceptance_fail'&&event.acceptanceInspection==='uninspected'&&event.note.includes('整批退回，统一复查'))&&!!events[0].acceptanceBatchId&&new Set(events.map(event=>event.acceptanceBatchId)).size===1);
  check(`${label}: uninspected returns excluded from first accuracy`,accuracy(value,pair.tids).total===0&&accuracy(value,pair.tids).passed===0);
  const changed=new Set(pair.tids),afterMap=new Map(value.tasks.map(task=>[task.tid,task]));
  check(`${label}: unrelated task projections unchanged`,before.tasks.filter(task=>!changed.has(task.tid)).every(task=>JSON.stringify(afterMap.get(task.tid))===JSON.stringify(task)));
  snapshots.push({label,revision:value.revision,tids:pair.tids,groups:[...new Set(selectedTasks(value,pair.tids).map(task=>task.groupId))],batchId:events[0].acceptanceBatchId});
}
async function main(){
  fs.mkdirSync(out,{recursive:true});
  const fixture=fork(path.join(__dirname,'acceptance-sampling-browser-server.cjs'),[],{silent:true,env:{...process.env,SAMPLING_TEST_PORT:String(port),SAMPLING_TEST_PACKAGED:'1'}});
  let browser,failure;
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture startup timeout')),20000);fixture.stdout.once('data',chunk=>{clearTimeout(timer);console.log(String(chunk).trim());resolve();});fixture.once('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exit '+code));});fixture.stderr.on('data',chunk=>process.stderr.write(chunk));});
    const cases=await seedCases();
    browser=await chromium.launch({headless:true,timeout:30000,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    const page=await open(browser,profiles.single);
    check('exact packaged prod78 script is loaded',await page.locator(`script[src="${expectedApp}"]`).count()===1);
    const loaded=await page.request.get(origin+'/group-workbench/'+expectedApp);
    check('served candidate equals packaged artifact',createHash('sha256').update(await loaded.body()).digest('hex')===createHash('sha256').update(fs.readFileSync(path.join(packageDir,expectedApp))).digest('hex'));
    const invalidRevision=(await state()).revision;
    await finder(page,['UNKNOWN-CROSS-GROUP','DONE-001','MULTI-010']);
    const invalid=await page.locator('#acceptancePreview').innerText();
    check('unknown, completed and opposite-mode TIDs are non-selectable',invalid.includes('尚未导入')&&invalid.includes('不可登记')&&/镜头|模块/.test(invalid)&&await page.locator('#acceptanceCommitBtn').isDisabled()&&await page.locator('input[name="acceptanceImportTask"]:checked').count()===0);
    check('invalid preview performs no writes',(await state()).revision===invalidRevision);
    await finder(page,[cases.single.finder.tids[0],cases.multi.finder.tids[0]]);
    check('mixed-mode paste only offers current-mode matched task',await page.locator('input[name="acceptanceImportTask"]:checked').count()===1&&(await page.locator('#acceptancePreview').innerText()).includes('异常 1 条'));
    check('mixed-mode preview leaves both tasks pending',(await state()).revision===invalidRevision);
    for(const mode of ['single','multi']){
      const current=mode==='single'?page:await open(browser,profiles.multi),pair=cases[mode].finder;
      const groupIds=mode==='single'?['g01','g02']:['g06','g07'],groupLabels=await Promise.all(groupIds.map(id=>current.locator(`#scopeGroup option[value="${id}"]`).innerText()));
      await current.locator('#scopeGroup').selectOption(groupIds[0]);
      const beforeFiltered=(await state()).revision;await finder(current,[pair.tids[0],pair.tids[3]]);
      check(`${mode}: selected group filter still excludes other groups`,await current.locator('input[name="acceptanceImportTask"]:checked').count()===1&&(await current.locator('#acceptancePreview').innerText()).includes('异常 1 条')&&/小组|范围/.test(await current.locator('#acceptancePreview').innerText())&&(await state()).revision===beforeFiltered);
      await current.locator('#scopeGroup').selectOption('all');
      await finder(current,pair.tids);
      check(`${mode}: Finder enables a mixed-group fixed selection`,await current.locator('#acceptanceCommitBtn').isEnabled()&&await current.locator('input[name="acceptanceImportTask"]:checked').count()===4);
      const summary=await current.locator('#acceptanceChoiceSummary').innerText();
      check(`${mode}: Finder summarizes two groups with two members each`,summary.includes('2 个小组')&&groupLabels.every(label=>summary.includes(`${label} 2 条`)));
      await current.locator('#acceptanceImportDetails').screenshot({path:path.join(out,`${mode}-cross-group-finder.png`)});
      let before=await state(),start=transactionRequests.length;await saveFinder(current);await assertSaved(`${mode} Finder`,pair,before,start);

      const list=cases[mode].toolbar;await selectMovie(current,list.movie);
      const preSample=(await state()).revision;
      await current.locator('#acceptanceSampleBatch').click();
      check(`${mode}: sampling-based batch action retains its same-group restriction`,await current.locator('#acceptanceSampleForm').count()===0&&/一个小组|同一小组/.test(await current.locator('body').innerText())&&(await state()).revision===preSample);
      await current.locator('#acceptanceBulkReturn').click();await current.locator('#acceptanceBulkDecisionForm').waitFor({state:'visible'});
      await current.locator('#acceptanceBulkDecisionForm [name="note"]').fill('跨组统一复查');
      check(`${mode}: toolbar enables same-mode mixed groups`,await current.locator('#acceptanceBulkDecisionForm button[type="submit"]').isEnabled()&&(await current.locator('#acceptanceBulkDecisionForm h3').innerText()).includes('4'));
      const toolbarSummary=await current.locator('#acceptanceBulkDecisionForm').innerText();
      check(`${mode}: toolbar summarizes two groups with two members each`,toolbarSummary.includes('2 个小组')&&groupLabels.every(label=>toolbarSummary.includes(`${label} 2 条`)));
      await current.locator('#acceptanceBulkDecisionForm').screenshot({path:path.join(out,`${mode}-cross-group-toolbar.png`)});
      before=await state();start=transactionRequests.length;await saveToolbar(current);await assertSaved(`${mode} toolbar`,list,before,start);

      const finderConflict=cases[mode].finderConflict,note='跨组冲突后保留粘贴说明';
      await finder(current,finderConflict.tids,'acceptance_batch_return',note);
      await action({action:'edit',tid:finderConflict.tids[3]});before=await state();
      await saveFinder(current);let after=await state();
      check(`${mode}: one stale Finder member prevents every write`,after.revision===before.revision&&decisions(after,finderConflict.tids).length===0);
      check(`${mode}: failed Finder preserves TIDs selection choice and note`,await current.locator('#acceptanceText').inputValue()===finderConflict.tids.join('\n')&&await current.locator('#acceptanceChoice [value="acceptance_batch_return"]').isChecked()&&await current.locator('#acceptanceChoiceNote').inputValue()===note&&await current.locator('input[name="acceptanceImportTask"]:checked').count()===4);

      const toolbarConflict=cases[mode].toolbarConflict;await toolbar(current,toolbarConflict,'跨组冲突后保留列表说明');
      await action({action:'edit',tid:toolbarConflict.tids[3]});before=await state();
      await saveToolbar(current,false);after=await state();
      check(`${mode}: one stale toolbar member prevents every write`,after.revision===before.revision&&decisions(after,toolbarConflict.tids).length===0);
      check(`${mode}: failed toolbar retains fixed members and note`,await current.locator('#acceptanceBulkDecisionForm [name="note"]').inputValue()==='跨组冲突后保留列表说明'&&await current.locator('#acceptanceBulkDecisionForm').evaluate(form=>form.__selected.length)===4);
      await current.locator('#acceptanceBulkDecisionForm [data-action="cancel-bulk-acceptance"]').click();
      if(await current.locator('#acceptanceClearFilters').isEnabled())await current.locator('#acceptanceClearFilters').click();
      await finder(current,[mode==='single'?'RETURN-010':'MULTI-010'],'acceptance_fail','实际检查发现主体缺失');
      await saveFinder(current);after=await state();
      const actualTid=mode==='single'?'RETURN-010':'MULTI-010';
      check(`${mode}: ordinary inspected failure still contributes to accuracy`,decisions(after,[actualTid]).length===1&&decisions(after,[actualTid])[0].acceptanceInspection==='fail'&&accuracy(after,[actualTid]).total===1&&accuracy(after,[actualTid]).passed===0);
    }
    check('all pages remain free of browser errors and external requests',errors.length===0);
  }catch(error){failure=error;errors.push(error.stack||String(error));}
  finally{
    if(browser)await browser.close();fixture.kill();
    const sourceHashes=Object.fromEntries(fs.readdirSync(packageDir).filter(name=>/\.(?:js|css|html)$/.test(name)).map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(packageDir,name))).digest('hex')]));
    const report={ok:!failure,checks,errors,packaged:true,sourceHashes,snapshots,syntheticOnly:true,productionBusinessWrites:0};
    fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }
  if(failure)throw failure;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
