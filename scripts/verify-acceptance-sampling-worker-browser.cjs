'use strict';
// Uses the loopback fixture after its first 100-return and 100-pass browser cases.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/yeddashang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin='http://127.0.0.1:43187',out=path.resolve(__dirname,'../../browser');
async function main(){
  const response=await fetch(origin+'/group-workbench-api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:{name:'导出验收',role:'acceptance',groupId:'g01',mode:'single'},pin:'isolated-test-group-pin'})});
  assert.equal(response.status,200);const auth=await response.json();
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',timeout:30000}),checks=[],errors=[],urls=[];
  const check=(label,value)=>{assert(value,label);checks.push(label);console.log('PASS '+label);};
  try{
    const context=await browser.newContext({viewport:{width:1520,height:1050},timezoneId:'Asia/Shanghai',acceptDownloads:true});
    await context.addInitScript(value=>{if(location.hostname==='127.0.0.1')sessionStorage.setItem('r2v-group-workbench-shared-v1:session',JSON.stringify(value));},auth);
    const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>urls.push(r.url()));
    await page.goto(origin+'/group-workbench/');await page.locator('#appShell').waitFor({state:'visible'});
    await page.locator('nav [data-view="acceptance"]').click();await page.locator('#scopeGroup').selectOption('g01');await page.locator('[data-date-preset="all"]').click();
    const initial=await fetch(origin+'/__test/state').then(r=>r.json());
    for(const [kind,file]of [['acceptanceAccuracy','real-worker-accuracy.csv'],['acceptanceHistory','real-worker-history.csv']]){
      console.log('EXPORT '+kind);
      await page.locator('#acceptanceExportMenu summary').click();
      const downloaded=page.waitForEvent('download',{timeout:20000});
      await page.locator(`#acceptanceExportMenu [data-export="${kind}"]`).first().click();
      const download=await downloaded;await download.saveAs(path.join(out,file));
      const csv=fs.readFileSync(path.join(out,file),'utf8');
      if(kind==='acceptanceAccuracy')check('actual worker denominator CSV contains inspected pass/fail only',csv.includes('RETURN-001')&&csv.includes('RETURN-010')&&!csv.includes('RETURN-011')&&!csv.includes('PASS-011'));
      else check('actual worker history CSV preserves uninspected batch result',csv.includes('RETURN-011')&&csv.includes('PASS-011')&&csv.includes('未实检')&&csv.includes('实际检查结果'));
    }
    const final=await fetch(origin+'/__test/state').then(r=>r.json());
    check('downloads do not mutate synthetic task state',final.revision===initial.revision);
    check('prod74 worker requested in actual browser',urls.some(url=>/export-worker\.20261020-prod74/.test(url)));
    check('actual browser has no JavaScript errors',errors.length===0);
    const report={ok:true,checks,errors,workerUrls:urls.filter(url=>/export-worker/.test(url)),syntheticOnly:true};
    fs.writeFileSync(path.join(out,'sampling-worker-browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
