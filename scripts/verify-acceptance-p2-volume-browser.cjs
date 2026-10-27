'use strict';
// Real Chrome against synthetic loopback state. No production data or writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fork}=require('node:child_process'),{createHash}=require('node:crypto');
const {chromium}=require('C:/Users/yeddashang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const IO=require('../group-workbench/data-io.js');
const packaged=process.env.P2_TEST_PACKAGED==='1'||process.env.SAMPLING_TEST_PACKAGED==='1';
const expectedApp=process.env.P2_EXPECTED_APP||'app.20261027-prod83-p2-volume.js';
const packageDir=path.resolve(process.env.SAMPLING_TEST_PACKAGE_DIR||path.join(__dirname,'../../p2-volume/package/static'));
const inheritedDir=path.resolve(process.env.P2_INHERITED_STATIC_DIR||path.join(__dirname,'../../acceptance-p2/package/static'));
function frozenResource(name){const current=path.join(packageDir,name);return fs.existsSync(current)?current:name==='workflow.20261027-prod82-acceptance-p2.js'?path.join(inheritedDir,name):current;}
const out=path.resolve(process.env.P2_TEST_OUTPUT_DIR||path.join(__dirname,'../../p2-volume'));
const port=Number(process.env.P2_TEST_PORT||43205),origin=`http://127.0.0.1:${port}`;
const checks=[],errors=[],resourceHashes=[],responseChecks=[],loadedAssets=[],exportChecks=[];
const capturedResources=new Set();
const hash=body=>createHash('sha256').update(body).digest('hex');
const check=(label,condition)=>{assert(condition,label);checks.push(label);console.log('PASS '+label);};
async function login(mode){const profile={name:mode==='single'?'测试验收':'多镜验收',role:'acceptance',groupId:mode==='single'?'g01':'g06',mode};const response=await fetch(origin+'/group-workbench-api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile,pin:'isolated-test-group-pin'})});assert.equal(response.status,200,await response.clone().text());return response.json();}
async function range(page,from,to){await page.locator('#scopeDateFrom').fill(from);await page.locator('#scopeDateTo').fill(to);await page.locator('#scopeDateTo').dispatchEvent('change');}
async function metric(page,label,{total,p2,accuracy}){
  const expected=total?`${(p2/total*100).toFixed(1)}%`:'—';
  await page.waitForFunction(({expected,total,p2})=>document.getElementById('metricAcceptanceP2Rate').textContent===expected&&(total?document.getElementById('metricAcceptanceP2Detail').textContent.includes(`P2 ${p2} / 实检 ${total} 条`):document.getElementById('metricAcceptanceP2Detail').textContent.includes('暂无实检记录')),{expected,total,p2});
  check(label,await page.locator('#metricAcceptanceP2Rate').innerText()===expected);
  if(accuracy!==undefined)check(label+' · first accuracy unchanged',await page.locator('#metricAcceptanceAccuracy').innerText()===accuracy);
}
async function exportDetail(page,mode,label,total,p2){
  await page.locator('#overviewView .export-menu').evaluate(element=>element.open=true);
  const downloadPromise=page.waitForEvent('download');await page.locator('#overviewView [data-export="acceptanceP2"]').click();const download=await downloadPromise;
  const file=path.join(out,`${mode}-${label}.csv`);await download.saveAs(file);
  const csv=fs.readFileSync(file,'utf8'),table=IO.parseTable(csv),p2Index=table.headers.findIndex(value=>value==='是否发生P2'),tidIndex=table.headers.indexOf('TID');
  check(`${mode} ${label}: export identifies unique denominator and P2 numerator`,p2Index>=0&&tidIndex>=0&&table.rows.length===total&&table.rows.filter(row=>row[p2Index]==='是').length===p2&&new Set(table.rows.map(row=>row[tidIndex])).size===total);
  check(`${mode} ${label}: export file labels current scope`,download.suggestedFilename().includes('P2改判率明细')&&download.suggestedFilename().includes(mode==='single'?'单镜头':'多镜头'));
  exportChecks.push({mode,label,file,rows:table.rows.length,headers:table.headers,sha256:hash(csv),filename:download.suggestedFilename()});return table;
}
async function main(){
  fs.mkdirSync(out,{recursive:true});
  const fixture=fork(path.join(__dirname,'acceptance-sampling-browser-server.cjs'),[],{silent:true,env:{...process.env,SAMPLING_TEST_PORT:String(port),SAMPLING_TEST_P2_VOLUME:'1',SAMPLING_TEST_PACKAGED:packaged?'1':'0',SAMPLING_TEST_PACKAGE_DIR:packageDir}});
  let browser,failure;
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic fixture startup timed out')),20000);fixture.stdout.once('data',()=>{clearTimeout(timer);resolve();});fixture.once('exit',code=>{clearTimeout(timer);reject(Error('Synthetic fixture exited '+code));});fixture.stderr.on('data',data=>process.stderr.write(data));});
    browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    for(const mode of ['single','multi']){
      const prefix=mode==='single'?'VOLUME':'MULTIVOLUME';
      const auth=await login(mode),context=await browser.newContext({viewport:{width:1540,height:1100},timezoneId:'Asia/Shanghai'});
      await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(errors.push('External request '+route.request().url()),route.abort()));
      await context.addInitScript(value=>sessionStorage.setItem('r2v-group-workbench-shared-v1:session',JSON.stringify(value)),auth);
      const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
      page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/group-workbench-api/transactions')errors.push('Unexpected browser write');});
      page.on('response',response=>{const url=new URL(response.url());if(url.origin!==origin||!url.pathname.startsWith('/group-workbench/'))return;const name=url.pathname.endsWith('/')?'index.html':path.basename(url.pathname);if(name!=='index.html'&&!/^(app|reports|workflow|export-worker)\..+\.js$/.test(name))return;const key=mode+':'+name;if(capturedResources.has(key))return;capturedResources.add(key);responseChecks.push(response.body().then(body=>{const sha256=hash(body),file=packaged?frozenResource(name):undefined;resourceHashes.push({mode,name,url:response.url(),status:response.status(),sha256,frozenSource:file});if(packaged){assert(fs.existsSync(file),`Frozen resource missing: ${name}`);assert.equal(sha256,hash(fs.readFileSync(file)),`HTTP ${name} must match frozen package`);}}).catch(error=>errors.push(error.message)));});
      await page.goto(origin+'/group-workbench/');await page.locator('#appShell').waitFor({state:'visible'});await page.locator('nav [data-view="overview"]').click();
      const app=await page.locator('script[src^="app."]').getAttribute('src');loadedAssets.push({mode,app});if(packaged)check(`${mode}: packaged immutable app is prod83`,app.split('?')[0]===expectedApp);
      await page.locator('#scopeGroup').selectOption(mode==='single'?'g01':'g06');
      await range(page,'','');await metric(page,`${mode}: all rounds and cross-day TID dedup`,{total:5,p2:3,accuracy:'60.0%'});
      check(`${mode}: P2 metric follows first accuracy and describes all rounds`,await page.locator('#metricAcceptanceAccuracy').evaluate(node=>node.closest('.overview-metric').nextElementSibling.querySelector('#metricAcceptanceP2Rate')!==null)&&/首次与复验/.test(await page.locator('#metricAcceptanceP2Rate').locator('..').getAttribute('title')));
      const all=await exportDetail(page,mode,'all-dates',5,3);const records=all.headers.findIndex(value=>value.startsWith('实检记录数')),tid=all.headers.indexOf('TID');
      check(`${mode}: repeated same-day and cross-day inspections remain one exported TID`,records>=0&&all.rows.find(row=>row[tid]===prefix+'-002')?.[records]==='3');
      await range(page,'2026-10-21','2026-10-21');await metric(page,`${mode}: repeated checks on one day count once`,{total:3,p2:1,accuracy:'33.3%'});
      await range(page,'2026-10-22','2026-10-22');await metric(page,`${mode}: second-round P2 enters date-selected numerator`,{total:2,p2:1,accuracy:'100.0%'});
      const retest=await exportDetail(page,mode,'retest-date',2,1);check(`${mode}: date export includes reinspection and excludes uninspected/rejected`,retest.rows.some(row=>row[tid]===prefix+'-001')&&!retest.rows.some(row=>[prefix+'-004',prefix+'-005'].includes(row[tid])));
      await page.locator('#overviewView .export-menu').evaluate(element=>element.open=false);await page.screenshot({path:path.join(out,`${mode}-p2-volume-overview.png`),fullPage:true});
      await range(page,'2026-10-23','2026-10-23');await metric(page,`${mode}: third-round P2 enters date-selected numerator`,{total:2,p2:1,accuracy:'100.0%'});
      await range(page,'2026-10-21','2026-10-22');await metric(page,`${mode}: date interval deduplicates across days`,{total:4,p2:2,accuracy:'50.0%'});
      await page.locator('#scopeGroup').selectOption('all');await metric(page,`${mode}: all groups stay inside current shot mode`,{total:5,p2:3,accuracy:'60.0%'});
      await page.locator('#scopeGroup').selectOption(mode==='single'?'g02':'g07');await metric(page,`${mode}: individual group filtering`,{total:1,p2:1,accuracy:'100.0%'});
      await range(page,'2026-10-24','2026-10-24');await metric(page,`${mode}: empty dates show no rate`,{total:0,p2:0,accuracy:'—'});await exportDetail(page,mode,'empty-date',0,0);
      await range(page,'2026-10-23','2026-10-21');check(`${mode}: reversed dates do not show a misleading rate`,await page.locator('#metricAcceptanceP2Rate').innerText()==='—'&&(await page.locator('#metricAcceptanceP2Detail').innerText()).includes('请修正日期区间'));
      await context.close();
    }
    await Promise.all(responseChecks);check('no page errors, writes or external requests',errors.length===0);
    if(packaged)check('served index/app/reports/workflow/export worker match frozen bytes',resourceHashes.filter(row=>row.name==='index.html').length===2&&['app','reports','workflow','export-worker'].every(prefix=>resourceHashes.some(row=>row.name.startsWith(prefix+'.'))));
  }catch(error){failure=error;errors.push(error.stack||String(error));}
  finally{
    if(browser)await browser.close();fixture.kill();
    const sourceHashes=Object.fromEntries(['app.js','index.html','reports.js','workflow.js','export-worker.js'].map(name=>[name,hash(fs.readFileSync(path.join(__dirname,'../group-workbench',name)))]));
    const result={ok:!failure,checkedAt:new Date().toISOString(),checks,errors,packaged,packageDir,loadedAssets,resourceHashes,sourceHashes,exports:exportChecks,syntheticOnly:true,productionBusinessWrites:0};fs.writeFileSync(path.join(out,'volume-browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }
  if(failure)throw failure;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
