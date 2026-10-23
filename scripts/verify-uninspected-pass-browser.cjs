'use strict';
// Packaged release, real Chrome and the loopback-only API fixture. Synthetic
// tasks only; no external browser traffic or production business writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fork}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const {chromium}=require('C:/Users/yeddashang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const Reports=require('../group-workbench/reports.js');
const port=Number(process.env.UNINSPECTED_PASS_TEST_PORT||43196),origin=`http://127.0.0.1:${port}`;
const out=path.resolve(__dirname,'../../uninspected-pass'),packageDir=path.resolve(__dirname,'../../package/static');
const expectedApp='app.20261023-prod79-uninspected-pass.js';
const expectedHashes={app:'941ad24ec00424442e7ef78d556ae387181ec0fbdfa18c44dba8a32d420ea796',index:'b61d92103ccf33c934d85edc54c3d255adc33aba2ac908f3d4cd8b41bd65fa04'};
const checks=[],errors=[],transactionRequests=[],snapshots=[];
const check=(label,value)=>{assert(value,label);checks.push(label);console.log('PASS '+label);};
const profiles={single:{name:'测试验收',role:'acceptance',groupId:'g01',mode:'single'},multi:{name:'多镜验收',role:'acceptance',groupId:'g06',mode:'multi'}};
const groupsFor=mode=>mode==='single'?['g01','g02']:['g06','g07'];
const annotatorFor=groupId=>['g01','g06'].includes(groupId)?'随批一组标注':'随批二组标注';
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
  const definitions=[['finder','F','粘贴'],['toolbar','T','列表'],['detail','D','单条'],['actual','A','实检'],['return','R','退回'],['finderConflict','FC','粘贴冲突'],['toolbarConflict','TC','列表冲突']];
  for(const mode of ['single','multi']){
    const prefix=mode==='single'?'S':'M',label=mode==='single'?'单镜':'多镜';cases[mode]={};
    for(const [key,code,title]of definitions){
      const pair={movie:`随批通过${label}${title}`,mode,tids:[]};cases[mode][key]=pair;
      groupsFor(mode).forEach((groupId,groupIndex)=>{
        const batch={id:'batch_'+randomUUID(),date:'2026-10-20',groupId,mode,movie:pair.movie,taskIds:[]};batches.push(batch);
        for(let index=1;index<=2;index++){
          const task={id:'task_'+randomUUID(),tid:`UP-${prefix}${code}-${groupIndex===0?'A':'B'}-${String(index).padStart(3,'0')}`,date:batch.date,groupId,mode,movie:pair.movie,batchId:batch.id};
          tasks.push(task);pair.tids.push(task.tid);batch.taskIds.push(task.id);
        }
      });
    }
  }
  await tx({name:'admin',role:'admin'},{tasks,batches,events:tasks.map(task=>event(task,'dispatch'))});
  console.log(`Synthetic import ready: ${tasks.length} tasks`);
  for(const groupId of ['g01','g02','g06','g07']){
    const members=tasks.filter(task=>task.groupId===groupId),mode=members[0].mode;
    await tx({name:annotatorFor(groupId),role:'annotation',groupId,mode},{events:members.flatMap(task=>[event(task,'claim'),event(task,'submit',{round:1})])});
    await tx({name:'随批测试组长',role:'qc',groupId,mode},{events:members.map(task=>event(task,'qc_pass',{qcRound:1}))});
    console.log(`Synthetic group ready: ${groupId}`);
  }
  console.log('Synthetic uninspected-pass fixtures ready');return cases;
}
async function open(browser,profile){
  const auth=await login(profile),context=await browser.newContext({viewport:{width:1540,height:1100},timezoneId:'Asia/Shanghai'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();errors.push('Blocked non-local request '+route.request().url());return route.abort();});
  await context.addInitScript(value=>{if(location.hostname==='127.0.0.1')sessionStorage.setItem('r2v-group-workbench-shared-v1:session',JSON.stringify(value));},auth);
  const page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/group-workbench-api/transactions')transactionRequests.push({page:profile.mode,body:request.postDataJSON()});});
  await page.goto(origin+'/group-workbench/');await page.locator('#appShell').waitFor({state:'visible'});
  await acceptanceView(page);return page;
}
async function acceptanceView(page){await page.locator('nav [data-view="acceptance"]').click();await page.locator('#acceptanceView').waitFor({state:'visible'});}
async function finder(page,tids,choice='acceptance_batch_pass',note=''){
  await page.locator('#acceptanceImportDetails').evaluate(el=>el.open=true);
  await page.locator('#acceptanceText').fill(tids.join('\n'));await page.locator('#acceptancePreviewBtn').click();
  await page.waitForFunction(()=>!document.getElementById('acceptancePreviewBtn').disabled&&!!document.querySelector('#acceptancePreview .import-result'));
  await page.locator(`#acceptanceChoice [value="${choice}"]`).check();await page.locator('#acceptanceChoiceNote').fill(note);
}
async function saveFinder(page){await page.locator('#acceptanceCommitBtn').click();await page.waitForFunction(()=>document.getElementById('acceptanceCommitBtn').textContent!=='正在保存…');}
async function selectMovie(page,title){
  const clear=page.locator('[data-list-clear="acceptanceTask"]');if(await clear.count()&&await clear.isEnabled())await clear.click();
  if(await page.locator('#acceptanceClearFilters').isEnabled())await page.locator('#acceptanceClearFilters').click();
  await page.locator('#acceptanceMovie').evaluate(el=>el.scrollIntoView({block:'center'}));
  await page.locator('#acceptanceMovie').click();await page.locator('#multiSelectLayer .multi-select-search').fill(title);
  await page.locator('#multiSelectLayer').getByText(title,{exact:true}).click();
  await page.locator('#multiSelectLayer .multi-select-search').press('Escape');
  await page.locator('#acceptanceSelectAllButton').click();
}
async function toolbar(page,pair,note=''){
  await selectMovie(page,pair.movie);await page.locator('#acceptanceBulkUninspectedPass').click();
  await page.locator('#acceptanceBulkDecisionForm').waitFor({state:'visible'});
  await page.locator('#acceptanceBulkDecisionForm [name="note"]').fill(note);
}
async function saveToolbar(page,success=true){
  await page.locator('#acceptanceBulkDecisionForm button[type="submit"]').click();
  if(success)await page.locator('#acceptanceBulkDecisionForm').waitFor({state:'detached'});
  else await page.waitForFunction(()=>!!document.querySelector('#acceptanceBulkDecisionForm button[type="submit"]:not(:disabled)'));
}
const selectedTasks=(value,tids)=>value.tasks.filter(task=>tids.includes(task.tid));
function decisions(value,tids){const ids=new Set(selectedTasks(value,tids).map(task=>task.id));return value.state.events.filter(event=>ids.has(event.taskId)&&['acceptance_pass','acceptance_fail'].includes(event.type));}
const accuracy=(value,tids)=>Reports.acceptanceAccuracy({tasks:selectedTasks(value,tids),events:value.state.events});
async function assertSaved(label,pair,before,requestStart,inspection='uninspected'){
  const value=await state(),events=decisions(value,pair.tids),requests=transactionRequests.slice(requestStart),old=new Map(selectedTasks(before,pair.tids).map(task=>[task.id,task]));
  check(`${label}: all selected members accepted`,events.length===pair.tids.length&&selectedTasks(value,pair.tids).every(task=>task.status==='accepted'));
  check(`${label}: group assignee and mode preserved`,selectedTasks(value,pair.tids).every(task=>task.groupId===old.get(task.id).groupId&&task.assignee===old.get(task.id).assignee&&task.mode===old.get(task.id).mode));
  check(`${label}: exactly one atomic transaction`,requests.length===1&&value.revision===before.revision+1&&requests[0].body.delta.events.length===pair.tids.length);
  check(`${label}: explicit acceptance inspection classification`,events.every(event=>event.type==='acceptance_pass'&&event.acceptanceInspection===inspection));
  if(inspection==='uninspected'){
    check(`${label}: one common batch ID`,!!events[0].acceptanceBatchId&&new Set(events.map(event=>event.acceptanceBatchId)).size===1);
    check(`${label}: excludes all selected TIDs from first accuracy`,accuracy(value,pair.tids).total===0&&accuracy(value,pair.tids).passed===0);
    const report=Reports.build({kind:'movies',state:value.state,tasks:selectedTasks(value,pair.tids),events:value.state.events,mode:pair.mode});
    const rows=report.movies.rows;
    check(`${label}: report counts passed closure without inspected quality`,rows.reduce((sum,row)=>sum+row.acceptedTIDs,0)===pair.tids.length&&rows.reduce((sum,row)=>sum+row.closedTIDs,0)===pair.tids.length&&rows.every(row=>row.firstAcceptanceInspectedTIDs===0));
  }else check(`${label}: actual inspection counts in first accuracy`,accuracy(value,pair.tids).total===pair.tids.length&&accuracy(value,pair.tids).passed===pair.tids.length);
  const changed=new Set(pair.tids),afterMap=new Map(value.tasks.map(task=>[task.tid,task]));
  check(`${label}: unrelated tasks unchanged`,before.tasks.filter(task=>!changed.has(task.tid)).every(task=>JSON.stringify(afterMap.get(task.tid))===JSON.stringify(task)));
  check(`${label}: existing event history unchanged`,JSON.stringify(value.state.events.slice(0,before.state.events.length))===JSON.stringify(before.state.events));
  snapshots.push({label,revision:value.revision,tids:pair.tids,inspection,batchId:events[0].acceptanceBatchId||null});return value;
}
async function overviewSnapshot(page,groupId='all'){
  await page.locator('#scopeGroup').selectOption(groupId);await page.locator('nav [data-view="overview"]').click();
  await page.locator('#overviewView').waitFor({state:'visible'});await page.locator('#overviewTab-people').click();
  return page.evaluate(()=>{
    const text=id=>document.getElementById(id).textContent;
    return {accuracy:text('metricAcceptanceAccuracy'),detail:text('metricAcceptanceAccuracyDetail'),passed:Number(text('metricTodayAccept')),closed:Number(text('metricComplete')),closedPassed:Number(text('metricClosedPassed')),people:[...document.querySelectorAll('#personStatsBody tr')].filter(row=>row.cells[0]?.textContent.startsWith('随批')).map(row=>({name:row.cells[0].textContent,group:row.cells[1].textContent,accepted:Number(row.cells[5].textContent),accuracy:row.cells[12].textContent}))};
  });
}
async function assertOverviewUninspected(page,mode,before,tids){
  const value=await state();
  for(const scope of ['all',...groupsFor(mode)]){
    const after=await overviewSnapshot(page,scope),prior=before[scope],added=selectedTasks(value,tids).filter(task=>scope==='all'||task.groupId===scope).length;
    check(`${mode} ${scope}: browser accuracy and first-inspection denominator unchanged`,after.accuracy===prior.accuracy&&after.detail===prior.detail);
    check(`${mode} ${scope}: browser passed and closed counts include uninspected`,after.passed===prior.passed+added&&after.closed===prior.closed+added&&after.closedPassed===prior.closedPassed+added);
    check(`${mode} ${scope}: personal first-inspection quality remains empty`,after.people.length>0&&after.people.every(row=>row.accuracy==='暂无首轮实检'));
    snapshots.push({label:`${mode} overview ${scope}`,before:prior,after});
  }
  await page.locator('#scopeGroup').selectOption('all');await acceptanceView(page);
}
async function main(){
  fs.mkdirSync(out,{recursive:true});
  const fixture=fork(path.join(__dirname,'acceptance-sampling-browser-server.cjs'),[],{silent:true,env:{...process.env,SAMPLING_TEST_PORT:String(port),SAMPLING_TEST_PACKAGED:'1',SAMPLING_TEST_COMPACT:'1'}});
  let browser,failure;
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture startup timeout')),20000);fixture.stdout.once('data',chunk=>{clearTimeout(timer);console.log(String(chunk).trim());resolve();});fixture.once('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exit '+code));});fixture.stderr.on('data',chunk=>process.stderr.write(chunk));});
    const cases=await seedCases();
    for(let attempt=0;attempt<2;attempt++){
      try{browser=await chromium.launch({headless:true,timeout:120000,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});break;}
      catch(error){if(attempt||!String(error.message).includes('Timeout'))throw error;console.log('Owned test browser startup timed out; retrying once against the same fixture.');}
    }
    const initial=await state(),initialLegacy=accuracy(initial,['DONE-001']);
    for(const mode of ['single','multi']){
      const page=await open(browser,profiles[mode]);
      if(mode==='single'){
        check('exact packaged prod79 script loaded',await page.locator(`script[src="${expectedApp}"]`).count()===1);
        const loaded=await page.request.get(origin+'/group-workbench/'+expectedApp);
        check('served app equals frozen candidate',createHash('sha256').update(await loaded.body()).digest('hex')===expectedHashes.app);
        check('packaged index equals frozen candidate',createHash('sha256').update(fs.readFileSync(path.join(packageDir,'index.html'))).digest('hex')===expectedHashes.index);
      }
      const baseline={};for(const groupId of ['all',...groupsFor(mode)])baseline[groupId]=await overviewSnapshot(page,groupId);
      await page.locator('#scopeGroup').selectOption('all');await acceptanceView(page);
      check(`${mode}: inspected and uninspected actions remain distinct`,(await page.locator('#acceptanceBulkPass').innerText())==='实检合格，验收通过'&&(await page.locator('#acceptanceBulkUninspectedPass').innerText())==='未实检，随批通过');
      const pair=cases[mode].finder,groupLabels=await Promise.all(groupsFor(mode).map(id=>page.locator(`#scopeGroup option[value="${id}"]`).innerText()));
      await finder(page,pair.tids);
      const summary=await page.locator('#acceptanceChoiceSummary').innerText(),help=await page.locator('#acceptanceChoiceHelp').innerText();
      check(`${mode}: Finder fixes four selected TIDs across two groups`,await page.locator('#acceptanceCommitBtn').isEnabled()&&await page.locator('input[name="acceptanceImportTask"]:checked').count()===4&&summary.includes('2 个小组')&&groupLabels.every(label=>summary.includes(`${label} 2 条`)));
      check(`${mode}: Finder explains no accuracy contribution and note optional`,/不计.*准确率/.test(help)&&!await page.locator('#acceptanceChoiceNote').evaluate(el=>el.required));
      await page.locator('#acceptanceImportDetails').screenshot({path:path.join(out,`${mode}-uninspected-finder.png`)});
      let before=await state(),start=transactionRequests.length;await saveFinder(page);await assertSaved(`${mode} Finder`,pair,before,start);
      const list=cases[mode].toolbar;await toolbar(page,list);
      const toolbarText=await page.locator('#acceptanceBulkDecisionForm').innerText();
      check(`${mode}: toolbar confirms frozen cross-group members`,toolbarText.includes('未实检')&&toolbarText.includes('4')&&groupLabels.every(label=>toolbarText.includes(`${label} 2 条`))&&await page.locator('#acceptanceBulkDecisionForm').evaluate(form=>form.__selected.length)===4);
      check(`${mode}: toolbar blocks competing actions and permits blank note`,await page.locator('#acceptanceBulkPass').isDisabled()&&await page.locator('#acceptanceBulkUninspectedPass').isDisabled()&&!await page.locator('#acceptanceBulkDecisionForm [name="note"]').evaluate(el=>el.required));
      await page.locator('#acceptanceBulkDecisionForm').screenshot({path:path.join(out,`${mode}-uninspected-toolbar.png`)});
      before=await state();start=transactionRequests.length;await saveToolbar(page);await assertSaved(`${mode} toolbar`,list,before,start);
      const detail=cases[mode].detail;await selectMovie(page,detail.movie);
      const row=page.locator('#acceptanceBody tr').filter({hasText:detail.tids[0]});await row.getByRole('button',{name:'查看 / 验收',exact:true}).click();
      await page.locator('#acceptanceForm [value="acceptance_batch_pass"]').check();
      check(`${mode}: single detail offers uninspected pass with explicit help`,/不计.*准确率/.test(await page.locator('#acceptanceForm [data-acceptance-choice-help]').innerText())&&!await page.locator('#acceptanceForm [name="note"]').evaluate(el=>el.required));
      await page.locator('#acceptanceForm').screenshot({path:path.join(out,`${mode}-uninspected-detail.png`)});
      before=await state();start=transactionRequests.length;await page.locator('#acceptanceForm button[type="submit"]').click();await page.locator('#acceptanceForm').waitFor({state:'detached'});
      await assertSaved(`${mode} detail`,{...detail,tids:[detail.tids[0]]},before,start);
      const uninspected=[...pair.tids,...list.tids,detail.tids[0]];await assertOverviewUninspected(page,mode,baseline,uninspected);

      const invalidRevision=(await state()).revision,opposite=cases[mode==='single'?'multi':'single'].finderConflict.tids[0];
      await finder(page,['UNKNOWN-UNINSPECTED-PASS','DONE-001',opposite]);
      const invalid=await page.locator('#acceptancePreview').innerText();
      check(`${mode}: unknown and opposite-mode tasks never selectable`,invalid.includes('尚未导入')&&/镜头|模块/.test(invalid)&&await page.locator('#acceptanceCommitBtn').isDisabled()&&await page.locator('input[name="acceptanceImportTask"]:checked').count()===0&&(await state()).revision===invalidRevision);
      await page.locator('#scopeGroup').selectOption(groupsFor(mode)[0]);await finder(page,[detail.tids[1],detail.tids[3]]);
      check(`${mode}: selected group still excludes other group's TIDs`,await page.locator('input[name="acceptanceImportTask"]:checked').count()===1&&(await page.locator('#acceptancePreview').innerText()).includes('异常 1 条')&&(await state()).revision===invalidRevision);
      await page.locator('#scopeGroup').selectOption('all');
      const finderConflict=cases[mode].finderConflict,note='并发冲突保留随批通过说明';
      await finder(page,finderConflict.tids,'acceptance_batch_pass',note);await action({action:'edit',tid:finderConflict.tids[3]});before=await state();await saveFinder(page);let after=await state();
      check(`${mode}: one stale Finder member prevents whole-batch writes`,after.revision===before.revision&&decisions(after,finderConflict.tids).length===0);
      check(`${mode}: stale Finder preserves draft selection decision and note`,await page.locator('#acceptanceText').inputValue()===finderConflict.tids.join('\n')&&await page.locator('#acceptanceChoice [value="acceptance_batch_pass"]').isChecked()&&await page.locator('#acceptanceChoiceNote').inputValue()===note&&await page.locator('input[name="acceptanceImportTask"]:checked').count()===4);
      const toolbarConflict=cases[mode].toolbarConflict;await toolbar(page,toolbarConflict,note);await action({action:'edit',tid:toolbarConflict.tids[3]});before=await state();await saveToolbar(page,false);after=await state();
      check(`${mode}: one stale toolbar member prevents whole-batch writes`,after.revision===before.revision&&decisions(after,toolbarConflict.tids).length===0);
      check(`${mode}: stale toolbar preserves frozen members and note`,await page.locator('#acceptanceBulkDecisionForm [name="note"]').inputValue()===note&&await page.locator('#acceptanceBulkDecisionForm').evaluate(form=>form.__selected.length)===4);
      await page.locator('#acceptanceBulkDecisionForm [data-action="cancel-bulk-acceptance"]').click();

      const actual=cases[mode].actual;await finder(page,[actual.tids[0]],'acceptance_pass','实际检查合格');before=await state();start=transactionRequests.length;await saveFinder(page);await assertSaved(`${mode} actual Finder`,{...actual,tids:[actual.tids[0]]},before,start,'pass');
      await selectMovie(page,actual.movie);before=await state();start=transactionRequests.length;await page.locator('#acceptanceBulkPass').click();
      await page.waitForFunction(()=>!document.querySelector('#acceptanceBody input[name="acceptanceTask"]:checked'));
      await assertSaved(`${mode} actual toolbar`,{...actual,tids:actual.tids.slice(1)},before,start,'pass');
      const actualOverview=await overviewSnapshot(page,'all');
      check(`${mode}: actual inspection updates browser first-accuracy denominator`,actualOverview.people.every(row=>row.accuracy.includes('100.0%')&&row.accuracy.includes('首轮实检 2 条')));
      await acceptanceView(page);
      const returned=cases[mode].return;await selectMovie(page,returned.movie);before=await state();await page.locator('#acceptanceSampleBatch').click();
      check(`${mode}: sampling still requires a single group`,await page.locator('#acceptanceSampleForm').count()===0&&(await state()).revision===before.revision);
      await finder(page,returned.tids,'acceptance_batch_return','整批回归检查');await saveFinder(page);after=await state();
      check(`${mode}: cross-group uninspected return remains available`,decisions(after,returned.tids).length===4&&selectedTasks(after,returned.tids).every(task=>task.status==='acceptance_return_pending')&&decisions(after,returned.tids).every(event=>event.acceptanceInspection==='uninspected')&&accuracy(after,returned.tids).total===0);
      await page.context().close();
    }
    const finalState=await state();
    check('legacy accepted history and quality remain unchanged',JSON.stringify(finalState.state.events.slice(0,initial.state.events.length))===JSON.stringify(initial.state.events)&&JSON.stringify(accuracy(finalState,['DONE-001']))===JSON.stringify(initialLegacy));
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
