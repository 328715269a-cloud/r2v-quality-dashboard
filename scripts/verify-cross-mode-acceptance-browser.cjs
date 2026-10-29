'use strict';
// Real Chrome, loopback-only API and synthetic tasks. Never connects to production.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fork}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {chromium}=require('C:/Users/yeddashang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const Flow=require('../group-workbench/workflow.js'),Reports=require('../group-workbench/reports.js');
const root=path.resolve(__dirname,'..'),base=path.resolve(root,'../cross-mode'),packaged=process.env.CROSS_MODE_TEST_PACKAGED==='1';
const port=Number(process.env.CROSS_MODE_TEST_PORT||43210),origin=`http://127.0.0.1:${port}`,out=path.join(base,packaged?'browser-packaged':'browser-source');
const packageDir=path.resolve(process.env.SAMPLING_TEST_PACKAGE_DIR||path.join(base,'package/static')),legacyDir=path.join(base,'legacy');
const checks=[],errors=[],requests=[],resourceChecks=[],assets=[],sourceHashes={};let fixture,browser,oldPageContinuity=false;
const check=(name,value)=>{assert(value,name);checks.push(name);console.log('PASS '+name);};
const profiles={single:{name:'测试验收',role:'acceptance',mode:'single',groupId:'g01'},multi:{name:'多镜验收',role:'acceptance',mode:'multi',groupId:'g06'}};
const authCache=new Map();
async function json(url,body,headers={}){const response=await fetch(origin+url,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{...(body?{'Content-Type':'application/json'}:{}),...headers}});assert.equal(response.status,200,await response.clone().text());return response.json();}
const state=()=>json('/__test/state'),action=body=>json('/__test/action',body);
async function login(profile){const key=JSON.stringify(profile);if(!authCache.has(key))authCache.set(key,await json('/group-workbench-api/session',{profile,pin:profile.role==='annotation'?undefined:profile.role==='admin'?'isolated-test-admin-pin':'isolated-test-group-pin'}));return authCache.get(key);}
async function tx(profile,delta){const auth=await login(profile);return json('/group-workbench-api/transactions',{id:randomUUID(),revision:(await state()).revision,delta,...(profile.role==='admin'?{pin:'isolated-test-admin-pin'}:{})},{'X-Workbench-Session':auth.token,'X-Workbench-Client':'import-delete-v1'});}
const ev=(task,type,extra={})=>({id:'event_'+randomUUID(),taskId:task.id,type,workflowVersion:3,...extra});
async function seed(){
 const groups=['g01','g02','g06','g07'],cases={},tasks=[],batches=[];
 for(const [name,count] of [['actual',4],['p2',4],['batchPass',4],['fail',4],['reject',4],['batchReturn',4],['page',121],['race',4],['keyword',4],['keywordSave',4],['oppositeSingle',2],['oppositeMulti',2]]){
  const members=[];cases[name]=members;
  for(let i=0;i<count;i++){const groupId=name==='oppositeSingle'?'g01':name==='oppositeMulti'?'g06':groups[i%4],mode=['g01','g02'].includes(groupId)?'single':'multi';const task={id:'task_'+randomUUID(),tid:`MIX-${name.toUpperCase()}-${String(i+1).padStart(3,'0')}`,date:'2026-10-29',groupId,mode,movie:`跨镜头${name}测试`,batchId:'batch_'+randomUUID()};tasks.push(task);members.push(task);batches.push({id:task.batchId,date:task.date,groupId,mode,movie:task.movie,taskIds:[task.id]});}
 }
 await tx({name:'admin',role:'admin'},{tasks,batches,events:tasks.map(task=>ev(task,'dispatch'))});
 for(const groupId of groups){const members=tasks.filter(task=>task.groupId===groupId),mode=members[0].mode;await tx({name:'混合标注',role:'annotation',groupId,mode},{events:members.flatMap(task=>[ev(task,'claim'),ev(task,'submit',{round:1})])});await tx({name:'混合质检',role:'qc',groupId,mode},{events:members.map(task=>ev(task,'qc_pass',{qcRound:1}))});}
 return cases;
}
async function open(profile,{legacy=false,patchState=null}={}){
 const auth=await login(profile),context=await browser.newContext({viewport:{width:1580,height:1050},timezoneId:'Asia/Shanghai'});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(errors.push('External request '+route.request().url()),route.abort()));
 await context.addInitScript(value=>sessionStorage.setItem('r2v-group-workbench-shared-v1:session',JSON.stringify(value)),auth);
 if(patchState)await context.route('**/group-workbench-api/state?*',async route=>{const response=await route.fetch(),body=await response.json();if(body.state)patchState(body.state);await route.fulfill({response,json:body});});
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.stack||String(error)));
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/group-workbench-api/transactions')requests.push({profile,body:request.postDataJSON()});});
 page.on('response',response=>{const u=new URL(response.url());if(!packaged||legacy||!u.pathname.startsWith('/group-workbench/'))return;const name=u.pathname.endsWith('/')?'index.html':path.basename(u.pathname);if(!/\.(html|js|css)$/.test(name))return;resourceChecks.push(response.body().then(bytes=>{const file=path.join(packageDir,name);if(!fs.existsSync(file))return;const hash=createHash('sha256').update(bytes).digest('hex');assert.equal(hash,createHash('sha256').update(fs.readFileSync(file)).digest('hex'),'HTTP frozen asset '+name);assets.push(name);const key=name==='index.html'?name:/^(app|reports|workflow)\./.exec(name)?.[1]+'.js';if(['index.html','app.js','reports.js','workflow.js'].includes(key)){if(sourceHashes[key])assert.equal(sourceHashes[key],hash);sourceHashes[key]=hash;}}));});
 await page.goto(origin+(legacy?'/legacy/group-workbench/':'/group-workbench/'));await page.locator('#appShell').waitFor({state:'visible'});
 if(profile.role==='acceptance'){await page.locator('nav [data-view="acceptance"]').click();await page.locator('#acceptanceView').waitFor({state:'visible'});}
 return page;
}
async function preview(page,tids,choice='acceptance_batch_return',note=''){
 await page.locator('#acceptanceImportDetails').evaluate(el=>el.open=true);await page.locator('#acceptanceText').fill(tids.join('\n'));await page.locator('#acceptancePreviewBtn').click();
 await page.waitForFunction(()=>!document.querySelector('#acceptancePreviewBtn').disabled&&!!document.querySelector('#acceptancePreview .import-result'));
 await page.locator(`#acceptanceChoice [value="${choice}"]`).check();await page.locator('#acceptanceChoiceNote').fill(note);
}
async function save(page){await page.locator('#acceptanceCommitBtn').click();await page.waitForFunction(()=>document.querySelector('#acceptanceCommitBtn').textContent!=='正在保存…');}
const targets=(s,members)=>s.tasks.filter(t=>members.some(m=>m.id===t.id));
function decisions(s,members){const ids=new Set(members.map(t=>t.id));return s.state.events.filter(e=>ids.has(e.taskId)&&['acceptance_pass','acceptance_fail'].includes(e.type));}
function accurate(s,members){return Reports.acceptanceAccuracy({tasks:targets(s,members),events:s.state.events});}
async function confirmAction(page,members,choice,note=''){
 const before=await state(),sent=requests.length;await preview(page,members.map(t=>t.tid),choice,note);
 check(choice+': mode column and separate selected totals',await page.locator('#acceptancePreview th').getByText('镜头',{exact:true}).count()===1&&(await page.locator('#acceptanceChoiceSummary').innerText()).includes('单镜头 2 条 · 多镜头 2 条'));
 await save(page);const after=await state(),events=decisions(after,members),actions=requests.slice(sent),passed=['acceptance_pass','acceptance_p2_pass','acceptance_batch_pass'].includes(choice),reject=choice==='acceptance_reject',uninspected=['acceptance_batch_pass','acceptance_batch_return'].includes(choice);
 check(choice+': all four modes/groups saved once atomically',events.length===4&&actions.length===1&&actions[0].body.delta.events.length===4&&after.revision===before.revision+1);
 check(choice+': correct status',targets(after,members).every(t=>t.status===(reject?'rejected':passed?'accepted':'acceptance_return_pending')));
 check(choice+': original mode/group/assignee preserved',targets(after,members).every(t=>{const old=targets(before,members).find(x=>x.id===t.id);return t.mode===old.mode&&t.groupId===old.groupId&&t.assignee===old.assignee&&t.acceptanceRound===1;}));
 check(choice+': actual/uninspected/reject semantics',events.every(e=>reject?Flow.isAcceptanceReject(e)&&!e.acceptanceInspection:e.acceptanceInspection===(uninspected?'uninspected':passed?'pass':'fail')));
 if(uninspected)check(choice+': one shared batch id',new Set(events.map(e=>e.acceptanceBatchId)).size===1&&!!events[0].acceptanceBatchId);
 const first=accurate(after,members);check(choice+': accuracy correctly includes or excludes samples',first.total===(uninspected||reject?0:4)&&first.passed===(passed&&!uninspected?4:0));
 for(const mode of ['single','multi']){const own=members.filter(t=>t.mode===mode),metric=accurate(after,own),p2=Reports.acceptanceP2({tasks:targets(after,own),events:after.state.events});check(choice+': '+mode+' statistics use only own TIDs',own.length===2&&metric.total===(uninspected||reject?0:2)&&metric.passed===(passed&&!uninspected?2:0)&&p2.total===(uninspected||reject?0:2)&&p2.p2Count===(choice==='acceptance_p2_pass'?2:0));}
 if(choice==='acceptance_p2_pass')check('P2 flagged while counting actual pass',events.every(e=>e.acceptanceIssueLevel==='P2')&&Reports.acceptanceP2({tasks:targets(after,members),events:after.state.events}).p2Count===4);
 const ids=new Set(members.map(t=>t.id));check(choice+': no unrelated task projection changes',before.tasks.filter(t=>!ids.has(t.id)).every(t=>JSON.stringify(t)===JSON.stringify(after.tasks.find(a=>a.id===t.id))));
 return after;
}
// Hold one real loopback response so edits can race the refresh deterministically.
async function holdNext(page,pattern){let release,startedResolve;const ready=new Promise(resolve=>startedResolve=resolve),gate=new Promise(resolve=>release=resolve);let used=false;const handler=async route=>{if(!used){used=true;startedResolve();await gate;}await route.continue();};await page.route(pattern,handler);return{ready,release:async()=>{release();await page.unroute(pattern,handler);}};}
async function keywordRaces(page,cases){
 const ids=cases.keyword.map(t=>t.tid),statePattern='**/group-workbench-api/state?*';await page.locator('#scopeGroup').selectOption('all');
 await preview(page,ids);let held=await holdNext(page,statePattern);await page.locator('#acceptanceKeyword').fill('MIX-KEYWORD-001');await page.locator('#acceptanceKeywordBtn').click();await held.ready;
 const replacement=ids.slice(1).join('\n');await page.locator('#acceptanceText').fill(replacement);await page.locator('#acceptancePreviewBtn').click();await held.release();await page.waitForFunction(()=>!document.querySelector('#acceptanceKeywordBtn').disabled&&!document.querySelector('#acceptancePreviewBtn').disabled);
 check('slow keyword refresh cannot replace newly pasted and previewed TIDs',await page.locator('#acceptanceText').inputValue()===replacement&&await page.locator('input[name="acceptanceImportTask"]:checked').count()===3);
 await preview(page,ids);held=await holdNext(page,statePattern);await page.locator('#acceptanceKeywordBtn').click();await held.ready;await page.locator('input[name="acceptanceImportTask"]').first().uncheck();await held.release();await page.waitForFunction(()=>!document.querySelector('#acceptanceKeywordBtn').disabled);
 check('slow keyword cannot overwrite a newer selection in the same draft',await page.locator('#acceptanceText').inputValue()===ids.join('\n')&&await page.locator('input[name="acceptanceImportTask"]:checked').count()===3);
 held=await holdNext(page,statePattern);await page.locator('#acceptanceKeywordBtn').click();await held.ready;await page.locator('#acceptanceChoice [value="acceptance_fail"]').check();await page.locator('#acceptanceChoiceNote').fill('等待期间更新的处理说明');await held.release();await page.waitForFunction(()=>!document.querySelector('#acceptanceKeywordBtn').disabled);
 check('slow keyword preserves a newer decision and note',await page.locator('#acceptanceText').inputValue()===ids.join('\n')&&await page.locator('#acceptanceChoiceNote').inputValue()==='等待期间更新的处理说明'&&await page.locator('input[name="acceptanceImportTask"]:checked').count()===3);
 held=await holdNext(page,statePattern);await page.locator('#acceptanceKeyword').fill('MIX-KEYWORD-001');await page.locator('#acceptanceKeyword').press('Enter');await held.ready;await page.locator('#acceptanceKeyword').fill('MIX-KEYWORD-002');await page.locator('#acceptanceKeyword').press('Enter');
 let nextRelease,nextReadyResolve,nextUsed=false;const nextReady=new Promise(resolve=>nextReadyResolve=resolve),nextGate=new Promise(resolve=>nextRelease=resolve),nextHandler=async route=>{if(!nextUsed){nextUsed=true;nextReadyResolve();await nextGate;}await route.continue();};await page.route(statePattern,nextHandler);await held.release();await nextReady;
 check('old search finally does not enable button during the newer search',await page.locator('#acceptanceKeywordBtn').isDisabled());nextRelease();await page.unroute(statePattern,nextHandler);await page.waitForFunction(()=>!document.querySelector('#acceptanceKeywordBtn').disabled&&!document.querySelector('#acceptancePreviewBtn').disabled);
 check('newest keyword wins reverse-continuation race',await page.locator('#acceptanceText').inputValue()==='MIX-KEYWORD-002'&&await page.locator('input[name="acceptanceImportTask"]:checked').count()===1);
 await preview(page,cases.keywordSave.map(t=>t.tid),'acceptance_p2_pass','实检修正说明');held=await holdNext(page,statePattern);await page.locator('#acceptanceKeyword').fill('MIX-KEYWORD-001');await page.locator('#acceptanceKeywordBtn').click();await held.ready;const transaction=await holdNext(page,'**/group-workbench-api/transactions');const sent=requests.length;
 await page.locator('#acceptanceCommitBtn').click();await held.release();await transaction.ready;
 check('keyword response during save preserves import and keeps controls disabled',await page.locator('#acceptanceText').inputValue()===cases.keywordSave.map(t=>t.tid).join('\n')&&await page.locator('#acceptanceKeywordBtn').isDisabled());await page.locator('#acceptanceCommitBtn').evaluate(el=>el.click());await transaction.release();await page.waitForFunction(()=>!document.querySelector('#acceptanceKeywordBtn').disabled&&document.querySelector('#acceptanceCommitBtn').textContent!=='正在保存…');
 check('keyword and duplicate-click races save one exact mixed decision',requests.length===sent+1&&decisions(await state(),cases.keywordSave).length===4&&decisions(await state(),cases.keyword).length===0);
}
async function main(){
 fs.mkdirSync(out,{recursive:true});let failure;
 fixture=fork(path.join(__dirname,'acceptance-sampling-browser-server.cjs'),[],{silent:true,env:{...process.env,SAMPLING_TEST_PORT:String(port),SAMPLING_TEST_COMPACT:'1',SAMPLING_TEST_PACKAGED:packaged?'1':'0',SAMPLING_TEST_PACKAGE_DIR:packageDir,SAMPLING_TEST_LEGACY_DIR:legacyDir}});
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture startup timeout')),25000);fixture.stdout.once('data',()=>{clearTimeout(timer);resolve();});fixture.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exit '+code));});fixture.stderr.on('data',data=>process.stderr.write(data));});
  const cases=await seed();browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await open(profiles.single);let crossSupported=false;
  await page.route('**/group-workbench-api/health',async route=>{const response=await route.fetch(),body=await response.json();if(!crossSupported)delete body.capabilities.acceptanceCrossMode;await route.fulfill({response,json:body});});
  await preview(page,cases.batchReturn.map(t=>t.tid),'acceptance_batch_return','混合退回说明');let before=await state(),sent=requests.length;await save(page);
  check('capability gate blocks cross-mode before transaction',(await state()).revision===before.revision&&requests.length===sent&&(await page.locator('#toast').innerText()).includes('尚不支持跨镜头'));
  check('capability block preserves text, selection, decision and note',await page.locator('#acceptanceText').inputValue()===cases.batchReturn.map(t=>t.tid).join('\n')&&await page.locator('#acceptanceChoiceNote').inputValue()==='混合退回说明'&&await page.locator('#acceptanceChoice [value="acceptance_batch_return"]').isChecked()&&await page.locator('input[name="acceptanceImportTask"]:checked').count()===4);
  await preview(page,cases.oppositeMulti.map(t=>t.tid),'acceptance_pass');before=await state();sent=requests.length;await save(page);
  check('opposite-mode-only input also requires capability',(await state()).revision===before.revision&&requests.length===sent);
  await preview(page,cases.oppositeSingle.map(t=>t.tid),'acceptance_pass');before=await state();await save(page);
  check('same-profile-mode action still works without new capability',(await state()).revision===before.revision+1);
  crossSupported=true;
  // In-progress old-page input remains usable after another tab writes mixed modes.
  let oldPage;if(fs.existsSync(path.join(legacyDir,'index.html'))){oldPage=await open(profiles.single,{legacy:true});await preview(oldPage,['LEGACY-001'],'acceptance_fail','旧页说明保留');}
  for(const [name,choice,note] of [['actual','acceptance_pass',''],['p2','acceptance_p2_pass','验收已修正'],['batchPass','acceptance_batch_pass',''],['fail','acceptance_fail','实际检查有问题'],['reject','acceptance_reject','无法继续处理'],['batchReturn','acceptance_batch_return','统一复查']])await confirmAction(page,cases[name],choice,note);
  if(oldPage){check('old prod84 tab draft survives new mixed transaction',await oldPage.locator('#acceptanceChoiceNote').inputValue()==='旧页说明保留');before=await state();await save(oldPage);oldPageContinuity=(await state()).revision===before.revision+1&&decisions(await state(),(await state()).tasks.filter(t=>t.tid==='LEGACY-001')).every(e=>e.acceptanceInspection==='fail');check('old prod84 session can submit after new page mixed writes',oldPageContinuity);}
  const big=cases.page;await preview(page,big.map(t=>t.tid));
  check('large preview renders at most 50 rows, retains all 121 selected',await page.locator('#acceptancePreview tbody tr').count()===50&&(await page.locator('#acceptanceChoiceSummary').innerText()).includes('121 条'));
  await page.locator('#acceptanceImportSelectAll').uncheck();check('page uncheck leaves off-page selection intact',(await page.locator('#acceptanceChoiceSummary').innerText()).includes('71 条'));
  await page.getByRole('button',{name:'验收 TID 预览下一页',exact:true}).click();check('second page selection survives',await page.locator('input[name="acceptanceImportTask"]:checked').count()===50);
  await page.locator('[data-acceptance-import-action="clear"]').click();await page.locator('input[name="acceptanceImportTask"]').first().check();
  await page.getByRole('button',{name:'验收 TID 预览上一页',exact:true}).click();await page.locator('input[name="acceptanceImportTask"]').first().check();
  check('individual selection accumulates across pages',(await page.locator('#acceptanceChoiceSummary').innerText()).includes('已选 2 条'));
  await page.locator('[data-acceptance-import-action="all"]').click();check('explicit all-valid button selects entire result',(await page.locator('#acceptanceChoiceSummary').innerText()).includes('已选 121 条'));
  await page.locator('#scopeGroup').selectOption('g01');await page.locator('[data-mode="multi"]').click();await page.locator('#scopeGroup').selectOption('g06');
  check('mode and top-group changes keep unified preview and selection',(await page.locator('#acceptanceChoiceSummary').innerText()).includes('121 条')&&await page.locator('#acceptanceText').inputValue()===big.map(t=>t.tid).join('\n'));
  const queueText=await page.locator('#acceptanceQueueScope').innerText();check('queue remains scoped to active mode/group',queueText.includes('多镜头')&&queueText.includes('多镜头1组'));
  await page.locator('#acceptanceMovie').scrollIntoViewIfNeeded();await page.locator('#acceptanceMovie').click();await page.locator('#multiSelectLayer').getByText('跨镜头page测试',{exact:true}).dispatchEvent('click');await page.keyboard.press('Escape');
  check('queue filters do not clear unified selection',(await page.locator('#acceptanceChoiceSummary').innerText()).includes('121 条'));
  await page.locator('#acceptanceClearFilters').click();await page.locator('#acceptancePreview').screenshot({path:path.join(out,'mixed-paged-preview.png')});
  before=await state();sent=requests.length;await save(page);let after=await state();check('all 121 rows submit in one transaction after filter changes',requests.length===sent+1&&after.revision===before.revision+1&&decisions(after,big).length===121&&targets(after,big).every(t=>t.status==='acceptance_return_pending'));
  await page.locator('[data-mode="single"]').click();await preview(page,[cases.race[0].tid,cases.race[0].tid.toLowerCase(),cases.race[2].tid,'MIX-NOT-IMPORTED','DONE-001']);
  check('duplicates, unknown and already handled TIDs give explicit failures',await page.locator('input[name="acceptanceImportTask"]').count()===2&&(await page.locator('#acceptancePreview').innerText()).includes('TID 重复')&&(await page.locator('#acceptancePreview').innerText()).includes('尚未导入')&&(await page.locator('#acceptancePreview').innerText()).includes('不可登记验收结果'));
  const originalText=await page.locator('#acceptanceText').inputValue();await action({action:'edit',tid:cases.race[0].tid});before=await state();sent=requests.length;await save(page);after=await state();
  check('one stale task aborts entire mixed operation and keeps draft',after.revision===before.revision&&decisions(after,[cases.race[2]]).length===0&&await page.locator('#acceptanceText').inputValue()===originalText&&(await page.locator('#acceptanceChoiceSummary').innerText()).includes('已选 2 条'));
  // Ambiguous IDs are injected into this test tab only; the fixture DB is untouched.
  const ambiguous=cases.race[1],ambPage=await open(profiles.single,{patchState:s=>{const t=s.tasks.find(t=>t.id===ambiguous.id);s.tasks.push({...t,id:'task_ambiguous_shadow',mode:'multi',groupId:'g06'});}});
  await preview(ambPage,[ambiguous.tid]);check('ambiguous TID does not silently pick a task',(await ambPage.locator('#acceptancePreview').innerText()).includes('归属不明确')&&await ambPage.locator('input[name="acceptanceImportTask"]').count()===0&&await ambPage.locator('#acceptanceCommitBtn').isDisabled());
  const mismatch=cases.race[3],badGroup=await open(profiles.single,{patchState:s=>{s.tasks.find(t=>t.id===mismatch.id).groupId='g01';}});await preview(badGroup,[mismatch.tid]);check('mode/group inconsistency is rejected during preview',(await badGroup.locator('#acceptancePreview').innerText()).includes('小组与镜头类型不一致'));
  const qc=await open({name:'质检权限测试',role:'qc',mode:'single',groupId:'g01'});before=await state();sent=requests.length;await qc.locator('#acceptanceText').evaluate((el,tid)=>{el.value=tid;document.querySelector('#acceptancePreviewBtn').click();},cases.oppositeMulti[0].tid);await qc.waitForTimeout(100);check('QC cannot invoke unified acceptance even through hidden controls',(await state()).revision===before.revision&&requests.length===sent&&(await qc.locator('#acceptancePreview').textContent()).includes('请以验收'));
  const multi=await open(profiles.multi);await preview(multi,cases.oppositeMulti.map(t=>t.tid),'acceptance_pass');before=await state();await save(multi);check('multi-profile same-mode path remains available',(await state()).revision===before.revision+1);const reverseMixed=[cases.race[1],cases.race[3]];await preview(multi,reverseMixed.map(t=>t.tid),'acceptance_pass');before=await state();await save(multi);check('multi-profile can submit both modes through unified importer',(await state()).revision===before.revision+1&&decisions(await state(),reverseMixed).length===2);
  await keywordRaces(page,cases);
  await Promise.all(resourceChecks);if(packaged)check('frozen prod85 HTTP assets verified',assets.includes('app.20261029-prod85-cross-mode.js')&&['index.html','app.js','reports.js','workflow.js'].every(key=>sourceHashes[key]));
  check('no browser errors or external network',errors.length===0);
 }catch(error){failure=error;errors.push(error.stack||String(error));}
 finally{if(browser)await browser.close();if(fixture)fixture.kill();const report={ok:!failure,checks,errors,packaged,sourceHashes,oldPageContinuity,assets:[...new Set(assets)],syntheticOnly:true,productionBusinessWrites:0};fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify(report,null,2));if(packaged)fs.writeFileSync(path.join(base,'browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
 if(failure)throw failure;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
