'use strict';
// Synthetic loopback fixture, real Chrome, current source served through the
// existing immutable-URL mapping. No production data or external requests.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fork}=require('node:child_process');
const {createHash}=require('node:crypto');
const {chromium}=require('C:/Users/yeddashang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const packaged=process.env.P2_TEST_PACKAGED==='1'||process.env.SAMPLING_TEST_PACKAGED==='1';
const expectedApp=process.env.P2_EXPECTED_APP||'app.20261027-prod82-acceptance-p2.js';
const port=Number(process.env.P2_TEST_PORT||43204),origin=`http://127.0.0.1:${port}`,out=process.env.P2_TEST_OUTPUT_DIR?path.resolve(process.env.P2_TEST_OUTPUT_DIR):path.resolve(__dirname,packaged?'../../acceptance-p2':'../../p2-browser');
const packageDir=process.env.SAMPLING_TEST_PACKAGE_DIR?path.resolve(process.env.SAMPLING_TEST_PACKAGE_DIR):path.resolve(__dirname,'../../acceptance-p2/package/static');
const inheritedDir=path.resolve(process.env.P2_INHERITED_STATIC_DIR||path.join(__dirname,'../../acceptance-p2/package/static'));
function frozenResource(name){const current=path.join(packageDir,name);return fs.existsSync(current)?current:name==='workflow.20261027-prod82-acceptance-p2.js'?path.join(inheritedDir,name):current;}
const checks=[],errors=[],requests=[],loadedAssets=[],resourceHashes=[],responseChecks=[];
const check=(label,value)=>{assert(value,label);checks.push(label);console.log('PASS '+label);};
async function state(){const response=await fetch(origin+'/__test/state');assert(response.ok);return response.json();}
async function login(profile){const response=await fetch(origin+'/group-workbench-api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile,pin:'isolated-test-group-pin'})});assert.equal(response.status,200,await response.clone().text());return response.json();}
async function acceptance(page){await page.locator('nav [data-view="acceptance"]').click();await page.locator('#acceptanceView').waitFor({state:'visible'});}
async function find(page,tids,type='acceptance_p2_pass',note=''){
  await page.locator('#acceptanceImportDetails').evaluate(element=>element.open=true);
  await page.locator('#acceptanceText').fill(tids.join('\n'));await page.locator('#acceptancePreviewBtn').click();
  await page.waitForFunction(()=>!document.getElementById('acceptancePreviewBtn').disabled&&!!document.querySelector('#acceptancePreview .import-result'));
  await page.locator(`#acceptanceChoice [value="${type}"]`).check();await page.locator('#acceptanceChoiceNote').fill(note);
}
async function saveFinder(page){await page.locator('#acceptanceCommitBtn').click();await page.waitForFunction(()=>document.getElementById('acceptanceCommitBtn').textContent!=='正在保存…');}
async function selectMovie(page,title){
  if(await page.locator('[data-list-clear="acceptanceTask"]').isEnabled())await page.locator('[data-list-clear="acceptanceTask"]').click();
  if(await page.locator('#acceptanceClearFilters').isEnabled())await page.locator('#acceptanceClearFilters').click();
  await page.locator('#acceptanceMovie').click();await page.locator('#multiSelectLayer .multi-select-search').fill(title);
  await page.locator('#multiSelectLayer').getByText(title,{exact:true}).click();await page.locator('#multiSelectLayer .multi-select-search').press('Escape');
}
async function blockedSave(page,save,label,draftCheck){
  const before=await state(),sent=requests.length;await save();
  await page.locator('#toast').filter({hasText:'尚不支持 P2'}).waitFor({state:'visible'});
  check(`${label}: old API capability blocks before any transaction`,(await state()).revision===before.revision&&requests.length===sent);
  check(`${label}: choices and drafts remain available`,await draftCheck());
}
async function main(){
  fs.mkdirSync(out,{recursive:true});
  const fixture=fork(path.join(__dirname,'acceptance-sampling-browser-server.cjs'),[],{silent:true,env:{...process.env,SAMPLING_TEST_PORT:String(port),SAMPLING_TEST_COMPACT:'1',SAMPLING_TEST_PACKAGED:packaged?'1':'0',SAMPLING_TEST_PACKAGE_DIR:packageDir}});
  let browser,failure;
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture startup timed out')),20000);fixture.stdout.once('data',()=>{clearTimeout(timer);resolve();});fixture.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});fixture.stderr.on('data',data=>process.stderr.write(data));});
    browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    for(const mode of ['single','multi']){
      const auth=await login({name:mode==='single'?'测试验收':'多镜验收',role:'acceptance',groupId:mode==='single'?'g01':'g06',mode});
      const context=await browser.newContext({viewport:{width:1540,height:1100},timezoneId:'Asia/Shanghai'});
      await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(errors.push('External request '+route.request().url()),route.abort()));
      await context.addInitScript(value=>sessionStorage.setItem('r2v-group-workbench-shared-v1:session',JSON.stringify(value)),auth);
      const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
      page.on('response',response=>{
        const url=new URL(response.url());if(url.origin!==origin||!url.pathname.startsWith('/group-workbench/'))return;
        const name=url.pathname.endsWith('/')?'index.html':path.basename(url.pathname);if(name!=='index.html'&&!/^(app|reports|workflow|export-worker)\..+\.js$/.test(name))return;
        responseChecks.push(response.body().then(body=>{const sha256=createHash('sha256').update(body).digest('hex'),file=packaged?frozenResource(name):undefined;resourceHashes.push({mode,url:response.url(),status:response.status(),name,sha256,frozenSource:file});if(packaged){assert(fs.existsSync(file),`Missing frozen resource ${name}`);assert.equal(sha256,createHash('sha256').update(fs.readFileSync(file)).digest('hex'),`HTTP resource ${name} must match frozen package`);}}).catch(error=>errors.push(error.message)));
      });
      page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/group-workbench-api/transactions')requests.push(request.postDataJSON());});
      let p2Supported=false,healthReads=0;
      await page.route('**/group-workbench-api/health',async route=>{healthReads++;const response=await route.fetch(),body=await response.json();if(!p2Supported)delete body.capabilities.acceptanceP2;await route.fulfill({response,json:body});});
      await page.goto(origin+'/group-workbench/');await page.locator('#appShell').waitFor({state:'visible'});await acceptance(page);
      const appAsset=await page.locator('script[src*="/app."]').count()?await page.locator('script[src*="/app."]').getAttribute('src'):await page.locator('script[src^="app."]').getAttribute('src');
      loadedAssets.push({mode,app:appAsset});if(packaged)check(`${mode}: immutable packaged app URL loaded`,appAsset?.split('?')[0].endsWith(expectedApp));
      const detailTid=mode==='single'?'DRAFT-001':'MULTI-001',finderTid=mode==='single'?'LEGACY-001':'MULTI-002',bulkTid=mode==='single'?'LEGACY-002':'MULTI-003';

      await page.locator('#acceptanceBody tr').filter({has:page.getByText(detailTid,{exact:true})}).getByRole('button',{name:'查看 / 验收',exact:true}).click();
      await page.locator('#acceptanceForm [value="acceptance_p2_pass"]').check();
      check(`${mode} single: P2 explanation is optional`,!await page.locator('#acceptanceForm [name="note"]').evaluate(element=>element.required));
      await page.locator('#acceptanceWorkbench').screenshot({path:path.join(out,`${mode}-p2-single.png`)});
      await blockedSave(page,()=>page.locator('#acceptanceForm button[type="submit"]').click(),`${mode} single`,()=>page.locator('#acceptanceForm [value="acceptance_p2_pass"]').isChecked());
      p2Supported=true;await page.locator('#acceptanceForm button[type="submit"]').click();await page.locator('#acceptanceForm').waitFor({state:'detached'});

      await find(page,[finderTid],'acceptance_p2_pass','保留 P2 修正说明');p2Supported=false;
      await blockedSave(page,()=>saveFinder(page),`${mode} pasted TID`,async()=>await page.locator('#acceptanceText').inputValue()===finderTid&&await page.locator('#acceptanceChoice [value="acceptance_p2_pass"]').isChecked()&&await page.locator('#acceptanceChoiceNote').inputValue()==='保留 P2 修正说明'&&await page.locator('input[name="acceptanceImportTask"]:checked').count()===1);
      p2Supported=true;await saveFinder(page);
      check(`${mode} pasted result identifies P2`,(await page.locator('#acceptanceImportFeedback').innerText()).includes('成功更新 1 条')&&(await page.locator('#acceptancePreview').innerText()).includes('P2'));
      await page.locator('#acceptanceImportDetails').evaluate(element=>element.open=false);

      await page.locator('#acceptanceBody tr').filter({has:page.getByText(bulkTid,{exact:true})}).locator('input[name="acceptanceTask"]').check();
      await page.locator('#acceptanceBulkP2Pass').click();p2Supported=false;
      check(`${mode} selected bulk: P2 note optional`,!await page.locator('#acceptanceBulkDecisionForm [name="note"]').evaluate(element=>element.required));
      await blockedSave(page,()=>page.locator('#acceptanceBulkDecisionForm button[type="submit"]').click(),`${mode} selected bulk`,async()=>await page.locator('#acceptanceBulkDecisionForm').evaluate(form=>form.dataset.decision==='acceptance_p2_pass'&&form.__selected.length===1));
      p2Supported=true;await page.locator('#acceptanceBulkDecisionForm button[type="submit"]').click();await page.locator('#acceptanceBulkDecisionForm').waitFor({state:'detached'});

      await selectMovie(page,mode==='single'?'随批放行测试':'多镜头抽检测试');await page.locator('#acceptanceSelectAllButton').click();await page.locator('#acceptanceSampleBatch').click();
      const sampleP2=mode==='single'?'PASS-001':'MULTI-004',samplePass=mode==='single'?'PASS-002':'MULTI-005',sampleFail=mode==='single'?'PASS-003':'MULTI-006';
      const form=page.locator('#acceptanceSampleForm');await form.locator('[name="inspectedTids"]').fill([sampleP2,samplePass,sampleFail].join('\n'));await form.locator('[name="failedTids"]').fill(sampleFail);await form.locator('[name="p2Tids"]').fill(sampleP2);await form.locator('[name="failureNote"]').fill('实检缺失');await form.locator('[name="note"]').fill('合成抽检批次');
      await form.locator('[name="batchAction"][value="return"]').check();
      check(`${mode} sample: P2 blocks whole return without clearing inputs`,await form.locator('button[type="submit"]').isDisabled()&&(await form.locator('.acceptance-sample-preview').innerText()).includes('不能整批退回')&&await form.locator('[name="p2Tids"]').inputValue()===sampleP2);
      await form.locator('[name="batchAction"][value="pass"]').check();await form.locator('[name="p2Tids"]').fill(sampleFail);
      check(`${mode} sample: overlapping P2/fail is blocked`,await form.locator('button[type="submit"]').isDisabled()&&(await form.locator('.acceptance-sample-preview').innerText()).includes('同时列入'));
      await form.locator('[name="p2Tids"]').fill(sampleP2);check(`${mode} sample: categories remain disjoint`,(await form.locator('.acceptance-sample-preview').innerText()).includes('实检合格 1 · P2修正后通过 1 · 实检不合格 1'));
      p2Supported=false;await blockedSave(page,()=>form.locator('button[type="submit"]').click(),`${mode} sample`,async()=>await form.locator('[name="p2Tids"]').inputValue()===sampleP2&&await form.locator('[name="failedTids"]').inputValue()===sampleFail&&await form.locator('[name="note"]').inputValue()==='合成抽检批次');
      await form.screenshot({path:path.join(out,`${mode}-p2-sample.png`)});
      p2Supported=true;await form.locator('button[type="submit"]').click();await form.waitFor({state:'detached'});

      const value=await state(),p2Tids=[detailTid,finderTid,bulkTid,sampleP2],tasks=value.tasks.filter(task=>p2Tids.includes(task.tid)),ids=new Set(tasks.map(task=>task.id)),events=value.state.events.filter(event=>ids.has(event.taskId)&&event.type==='acceptance_pass');
      check(`${mode}: all four entry points persist canonical P2 pass`,tasks.length===4&&tasks.every(task=>task.status==='accepted'&&task.acceptanceInspection==='pass'&&task.acceptanceIssueLevel==='P2')&&events.length===4&&events.every(event=>event.acceptanceIssueLevel==='P2'&&event.acceptanceInspection==='pass'));
      check(`${mode}: ordinary pass/fail/uninspected remain distinct`,value.tasks.find(task=>task.tid===samplePass).acceptanceIssueLevel===''&&value.tasks.find(task=>task.tid===sampleFail).status==='acceptance_return_pending');
      check(`${mode}: each P2 save health-checks even after a recent success`,healthReads>=8);
      await page.locator('nav [data-view="overview"]').click();await page.locator('[data-date-preset="all"]').click();
      const total=mode==='single'?7:6,expected=(4/total*100).toFixed(1)+'%';
      await page.waitForFunction(expected=>document.getElementById('metricAcceptanceP2Rate').textContent===expected,expected);
      check(`${mode}: P2 overview uses unique actual inspection TIDs`,await page.locator('#metricAcceptanceP2Rate').innerText()===expected&&(await page.locator('#metricAcceptanceP2Detail').innerText()).includes(`P2 4 / 实检 ${total}`));
      check(`${mode}: P2 metric immediately follows accuracy`,await page.locator('#metricAcceptanceAccuracy').evaluate(element=>element.closest('.overview-metric').nextElementSibling.querySelector('#metricAcceptanceP2Rate')!==null));
      await page.locator('#metricAcceptanceP2Rate').locator('..').screenshot({path:path.join(out,`${mode}-p2-metric.png`)});
      await page.screenshot({path:path.join(out,`${mode}-overview-full.png`),fullPage:true});
      if(mode==='single'){
        await acceptance(page);p2Supported=false;await find(page,['DRAFT-002'],'acceptance_pass','原普通通过不受 P2 能力影响');await saveFinder(page);
        const ordinary=(await state()).tasks.find(task=>task.tid==='DRAFT-002');check('ordinary actual pass remains available without P2 capability',ordinary.status==='accepted'&&ordinary.acceptanceInspection==='pass'&&!ordinary.acceptanceIssueLevel);
      }
      await context.close();
    }
    await Promise.all(responseChecks);check('no page errors or external network requests',errors.length===0);
    if(packaged)check('HTTP index and immutable app/workflow/reports match frozen package bytes',resourceHashes.filter(row=>row.name==='index.html').length===2&&['app','workflow','reports'].every(prefix=>resourceHashes.some(row=>row.name.startsWith(prefix+'.'))));
  }catch(error){failure=error;errors.push(error.stack||String(error));}
  finally{
    if(browser)await browser.close();fixture.kill();
    const sourceHashes=Object.fromEntries(['app.js','index.html','workflow.js','reports.js'].map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../group-workbench',name))).digest('hex')]));
    const packagedHashes=packaged?Object.fromEntries(fs.readdirSync(packageDir).filter(name=>/\.(js|css|html)$/.test(name)).map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(packageDir,name))).digest('hex')])):undefined;
    const result={ok:!failure,checkedAt:new Date().toISOString(),checks,errors,sourceHashes,packaged,packageDir,loadedAssets,resourceHashes,packagedHashes,syntheticOnly:true,productionBusinessWrites:0};fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }
  if(failure)throw failure;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
