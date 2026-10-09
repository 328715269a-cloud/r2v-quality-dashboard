'use strict';

// Entirely offline comparison of the immutable production baseline and candidate.
// Real browser DOM, synthetic histories, no init/login/store/network activity.
process.env.TZ = 'Asia/Shanghai';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'group-workbench');
const baselineApp = 'app.20261008-prod71-qc-volume.js';
const baselineReports = 'reports.20260924-prod65-reject-col.js';
// prod73 intentionally adds first-rejection cards and separates rejection from
// ordinary QC volume. Their exact semantics are covered by verify-rejection-split.
// Keep every other card, panel, export and cache comparison exact.
const changedMetricIds = ['metricAnnotationRejected','metricAnnotationRejectedHint','metricQcRejected','metricQcRejectedHint','metricQcVolume','metricQcVolumeDetail'];
const checks = [];
const equal = (label, actual, expected) => { assert.deepEqual(actual, expected, label); checks.push(label); };
const at = (day, hour = '09:00:00') => `2026-10-${String(day).padStart(2, '0')}T${hour}+08:00`;
const read = name => fs.readFileSync(path.join(directory, name), 'utf8');
const trace = message => { if(process.env.TRACE)console.error(message); };

function fixture() {
  const state = {version: 3, tasks: [], events: [], batches: [], preferences: {}};
  let sequence = 0;
  const event = (taskId, type, day, data = {}) => ({id: `e-${++sequence}`, taskId, type, at: at(day), actor: '质检员', actorRole: type.startsWith('acceptance_') ? 'acceptance' : 'qc', workflowVersion: 3, ...data});
  const add = (groupId, mode, name, history) => {
    const id = `${groupId}-${name}`;
    state.tasks.push({id, tid: `TID-${id}`, groupId, mode, movie: name === 'unclaimed' ? '未认领影片' : '跨组共同影片', date: '2026-09-01', createdAt: at(1, '08:00:00'), createdBy: '管理员', batchId: `batch-${groupId}`});
    state.events.push(event(id, 'dispatch', 1, {actor: '管理员', actorRole: 'admin'}));
    if (name !== 'unclaimed') state.events.push(event(id, 'claim', 1, {actor: '张明', actorRole: 'annotation', assignee: '张明'}));
    for (const [type, day, data] of history) state.events.push(event(id, type, day, data));
    return id;
  };
  const submit = {actor: '张明', actorRole: 'annotation', submissionKind: 'initial'};
  const fail = {pLevel: 'P1', tags: ['图片模糊/清晰度不足', '黑边/裁切不完整'], note: '合成回归测试'};
  for (const [groupId, mode] of [['g01', 'single'], ['g02', 'single'], ['g05', 'single'], ['g06', 'multi'], ['g07', 'multi']]) {
    add(groupId, mode, 'unclaimed', []);
    add(groupId, mode, 'submitted', [['submit', 2, submit]]);
    add(groupId, mode, 'accepted', [['submit', 2, submit], ['qc_pass', 3], ['acceptance_pass', 4]]);
    add(groupId, mode, 'rework', [['submit', 2, submit], ['qc_fail', 3, fail], ['submit', 4, {...submit, submissionKind: 'rework'}], ['qc_pass', 5], ['acceptance_fail', 6], ['acceptance_route', 6, {route: 'annotation', at: at(6, '10:00:00')}], ['submit', 7, {...submit, submissionKind: 'rework'}], ['qc_pass', 8], ['acceptance_pass', 9]]);
    add(groupId, mode, 'rejected', [['submit', 2, submit], ['qc_pass', 3], ['acceptance_reject', 4, {note: '验收拒绝'}]]);
    add(groupId, mode, 'reject-confirm', [['annotator_reject', 2, {actor: '张明', actorRole: 'annotation'}], ['reject_confirm', 3]]);
    add(groupId, mode, 'reject-return', [['annotator_reject', 2, {actor: '張明', actorRole: 'annotation'}], ['reject_return', 3]]);
    add(groupId, mode, 'legacy-qc-reject', [['submit', 2, submit], ['qc_fail', 3, {...fail, note: '[质检拒绝] 历史兼容'}]]);
    add(groupId, mode, 'direct-qc-reject', [['submit', 2, submit], ['qc_reject', 3, {note: '直接拒绝'}]]);
    add(groupId, mode, 'legacy-acceptance-reject', [['submit', 2, submit], ['qc_pass', 3], ['acceptance_fail', 4, {note: '[验收拒绝] 历史兼容'}]]);
    add(groupId, mode, 'released', [['submit', 2, submit], ['qc_fail', 3, fail], ['admin_release', 4, {actor: '管理员', actorRole: 'admin'}]]);
    add(groupId, mode, 'released-restart', [['submit', 2, submit], ['qc_fail', 3, fail], ['admin_release', 4, {actor: '管理员', actorRole: 'admin'}], ['claim', 5, {actor: '李明', actorRole: 'annotation', assignee: '李明'}], ['submit', 6, {...submit, actor: '李明'}], ['qc_pass', 7]]);
    add(groupId, mode, 'deleted', [['submit', 2, submit], ['qc_fail', 3, fail], ['task_deleted', 4, {actor: '管理员', actorRole: 'admin'}]]);
    add(groupId, mode, 'midnight', [['submit', 2, {...submit, at: '2026-10-01T16:00:00.000Z'}], ['qc_fail', 3, {...fail, at: '2026-10-02T15:59:59.999Z'}]]);
    const changed = add(groupId, mode, 'changed-tid', [['submit', 2, submit], ['qc_fail', 3, fail]]);
    state.events.push(event(changed, 'metadata_edit', 4, {actor: '管理员', actorRole: 'admin', before: {tid: `TID-${changed}`}, after: {tid: `REVISED-${changed}`}}));
    for (const day of [2, 3, 5]) state.events.push(event(`group:${groupId}`, 'group_daily_edit', day, {groupId, mode, date: at(day).slice(0, 10), actor: '组长', after: {leader: '组长', total: 9000, headcount: day === 3 ? 0 : 1.5}}));
    state.batches.push({id: `batch-${groupId}`, kind: 'import', groupId, mode, date: '2026-09-01', movie: '跨组共同影片', createdAt: at(1, '08:00:00'), createdBy: '管理员', taskIds: state.tasks.filter(t => t.groupId === groupId).map(t => t.id)});
  }
  return state;
}

const api = String.raw`
  const perfRenderCounts={};
  for(const name of ['renderGroupProgress','renderMovieProgress','renderDailyReport','renderPersonStats','renderErrorAnalysis']) {
    const original=eval(name);eval(name+' = function(...args){ perfRenderCounts["'+name+'"]=(perfRenderCounts["'+name+'"]||0)+1; return original(...args); }');
  }
  window.__overviewTest={
    configure(next){
      if(next.state)state=next.state;
      if(next.profile)profile=next.profile;
      if(next.mode)activeMode=next.mode;
      for(const [id,key] of [['scopeDateFrom','from'],['scopeDateTo','to'],['scopeGroup','group']])if(Object.hasOwn(next,key))$(id).value=next[key];
      if(next.tab)overviewTab=next.tab;
      currentView='overview';
    },
    render:()=>renderOverview(), select:(tab,focus=false)=>selectOverviewTab(tab,focus),
    reports:()=>scopedReports(), groupDaily:(source,date)=>groupDailyRows(source,date),
    currentGroupDaily:()=>groupDailyRows(),
    cacheSize:()=>typeof overviewCacheForState==='function'?overviewCacheForState().values.size:null,
    openDetails(){ $('personDailyDetails').open=true;$('errorAnalysisDetails').open=true; },
    resetCalls(){ for(const key of Object.keys(perfRenderCounts))delete perfRenderCounts[key]; window.__reportCalls.length=0; },
    calls:()=>({renders:{...perfRenderCounts},reports:window.__reportCalls.slice()}),
    preserveDrafts(){
      window.__draftNodes={};
      for(const id of ['groupDailyEditor','qcWorkbench','acceptanceWorkbench','dispatchPreview','taskEditor','batchEditor']){
        const host=$(id);if(!host)continue;const input=document.createElement('textarea');input.value='未提交草稿 '+id;host.replaceChildren(input);window.__draftNodes[id]=input;
      }
    },
    drafts:()=>Object.entries(window.__draftNodes).map(([id,node])=>({id,same:$(id).firstChild===node,value:node.value})),
    snapshot(tab){
      const ids={groups:['groupProgressBody','closureCheck','personDailyBody'],movies:['movieProgressBody','movieClosedBody','movieProgressSummary','rejectionSummaryBody'],daily:['overviewDailySummary','dailyStatsBody'],people:['personStatsBody','errorAnalysisBody']}[tab];
      return {
        cards:Object.fromEntries(Array.from($('overviewView').querySelectorAll('[id^="metric"]')).filter(n=>!n.id.startsWith('metricDaily')).map(n=>[n.id,n.textContent])),
        bodies:Object.fromEntries(ids.map(id=>[id,$(id)?.innerHTML||''])),
        dailyHead:tab==='daily'?$('dailyStatsBody').closest('table').querySelector('thead').innerHTML:'',
        board:$('statusBoard').innerHTML,followups:$('overviewFollowups').innerHTML,
        selected:Array.from(document.querySelectorAll('[data-overview-tab][role="tab"]')).filter(n=>n.getAttribute('aria-selected')==='true').map(n=>n.dataset.overviewTab),
        panels:Array.from(document.querySelectorAll('[data-overview-panel]')).filter(n=>!n.classList.contains('hidden')).map(n=>n.dataset.overviewPanel)
      };
    }
  };
  bindOverviewEvents();
`;

async function sandbox(browser, app, reports) {
  trace(`sandbox ${app}: new page`);
  const page = await browser.newPage({timezoneId: 'Asia/Shanghai'});
  await page.route('**/*', route => route.abort('blockedbyclient'));
  await page.setContent(read('index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, ''));
  trace(`sandbox ${app}: modules`);
  await page.addScriptTag({content: read('workflow.js')});
  await page.addScriptTag({content: read('data-io.js')});
  await page.addScriptTag({content: read(reports)});
  await page.evaluate(() => {
    window.__reportCalls = [];
    const reports = window.WorkbenchReports;
    window.WorkbenchReports = Object.fromEntries(Object.entries(reports).map(([key,value]) => [key, typeof value !== 'function' ? value : function(...args) { window.__reportCalls.push({name:key,kind:args[0]?.kind || ''});return value(...args); }]));
    window.WorkbenchStore = {create: () => ({revision: () => 'isolated'})};
  });
  const source = read(app);
  assert.match(source, /\n  init\(\);/);
  await page.addScriptTag({content: source.replace(/\n  init\(\);/, '\n' + api)});
  trace(`sandbox ${app}: setup`);
  await page.evaluate(() => {
    for (const id of ['scopeGroup']) document.getElementById(id).innerHTML = ['all','g01','g02','g05','g06','g07','missing'].map(value => `<option value="${value}">${value}</option>`).join('');
    window.__overviewTest.openDetails();
  });
  return page;
}

const call = (page, method, argument) => page.evaluate(({method,argument}) => window.__overviewTest[method](argument), {method,argument});
const snapshot = async (page, tab) => {
  const value = await call(page, 'snapshot', tab);
  for (const id of changedMetricIds) delete value.cards[id];
  return value;
};
async function compareTabs(baseline, candidate, label) {
  for (const tab of ['groups','movies','daily','people']) {
    await call(baseline, 'select', tab);await call(candidate, 'select', tab);
    equal(`${label}/${tab}: every card, table, status and accessibility panel`, await snapshot(candidate, tab), await snapshot(baseline, tab));
  }
}

function largeFixture(source, copies = 60) {
  const combined={version:3,tasks:[],events:[],batches:[],preferences:{}};
  for(let copy=0;copy<copies;copy++){
    const suffix=`-copy-${copy}`;
    combined.tasks.push(...source.tasks.map(task=>({...task,id:task.id+suffix,tid:task.tid+suffix,batchId:task.batchId+suffix,movie:task.movie+suffix})));
    combined.events.push(...source.events.map(event=>({...event,id:event.id+suffix,taskId:event.taskId.startsWith('group:')?event.taskId:event.taskId+suffix})));
    combined.batches.push(...source.batches.map(batch=>({...batch,id:batch.id+suffix,movie:batch.movie+suffix,taskIds:batch.taskIds.map(id=>id+suffix)})));
  }
  return combined;
}

async function measure(page, input) {
  return page.evaluate(input=>{
    const api=window.__overviewTest,samples={initialCold:[],unchangedWarm:[],dateChange:[],dateRepeatWarm:[],modeSwitch:[],firstMovies:[],firstDaily:[],firstPeople:[],returnGroups:[],repeatMovies:[],repeatDaily:[],repeatPeople:[]};
    const timed=(key,fn)=>{const start=performance.now();fn();samples[key].push(performance.now()-start);};
    for(let iteration=0;iteration<3;iteration++){
      const next=structuredClone(input);
      api.configure({state:next,profile:{name:'管理员',role:'admin'},mode:'single',group:'all',from:'2026-10-01',to:'2026-10-09',tab:'groups'});
      timed('initialCold',()=>api.render());
      timed('unchangedWarm',()=>api.render());
      api.configure({from:'2026-10-02',to:'2026-10-03'});
      timed('dateChange',()=>api.render());
      timed('dateRepeatWarm',()=>api.render());
      api.configure({mode:'multi'});
      timed('modeSwitch',()=>api.render());
      timed('firstMovies',()=>api.select('movies'));
      timed('firstDaily',()=>api.select('daily'));
      timed('firstPeople',()=>api.select('people'));
      timed('returnGroups',()=>api.select('groups'));
      timed('repeatMovies',()=>api.select('movies'));
      timed('repeatDaily',()=>api.select('daily'));
      timed('repeatPeople',()=>api.select('people'));
    }
    return Object.fromEntries(Object.entries(samples).map(([key,values])=>[key,{samplesMs:values.map(value=>Math.round(value*100)/100),medianMs:Math.round(values.slice().sort((a,b)=>a-b)[1]*100)/100}]));
  },input);
}

async function main() {
  const browserPath = process.env.BROWSER_PATH || ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',chromium.executablePath()].find(p => fs.existsSync(p));
  assert.ok(browserPath, 'An installed Chromium browser is needed for offline DOM validation');
  const browser = await chromium.launch({executablePath:browserPath, headless:true});
  try {
    const baseline = await sandbox(browser, baselineApp, baselineReports);
    const candidate = await sandbox(browser, 'app.js', 'reports.js');
    const state = fixture(), original = JSON.stringify(state);
    const initial = {state,profile:{name:'管理员',role:'admin'},mode:'single',from:'2026-10-01',to:'2026-10-09',group:'all',tab:'groups'};
    trace('initial render');
    for (const page of [baseline,candidate]) { await call(page,'configure',initial);await call(page,'resetCalls');await call(page,'render'); }
    equal('initial groups: all top cards, status and group tables', await snapshot(candidate,'groups'), await snapshot(baseline,'groups'));
    const firstCalls = await call(candidate,'calls');
    equal('initial render visits group panel only', firstCalls.renders, {renderGroupProgress:1});
    assert.ok(!firstCalls.reports.some(call => call.name === 'build' && !call.kind), 'Initial render must not build full export reports');
    checks.push('initial render requests no full export report');
    await compareTabs(baseline,candidate,'initial');
    trace('initial checked');
    const profiles = [{name:'管理员',role:'admin'},{name:'验收员',role:'acceptance'},{name:'质检员',role:'qc',groupId:'g01',mode:'single'},{name:'张明',role:'annotation',groupId:'g02',mode:'single'}];
    const scopes = [
      {from:'2026-10-02',to:'2026-10-02'}, {from:'2026-10-03',to:'2026-10-03'},
      {from:'2026-10-04',to:'2026-10-07'}, {from:'',to:''},
      {from:'',to:'2026-10-03'}, {from:'2026-10-06',to:''},
      {from:'2026-10-09',to:'2026-10-01'}, {from:'2026-12-01',to:'2026-12-01'}
    ];
    for (const [index,scope] of scopes.entries()) {
      trace(`scope ${index}`);
      const settings = {...scope,profile:profiles[index % profiles.length],mode:index % 3 === 0 ? 'multi' : 'single',group:index % 2 ? 'all' : index % 3 === 0 ? 'g06' : 'g01',tab:'groups'};
      // The legacy projection cache is state-only; refresh its state for an identity change.
      // The candidate deliberately keeps the same state identity to test its permission key.
      await call(baseline,'configure',{...settings,state});await call(candidate,'configure',settings);
      await call(baseline,'render');await call(candidate,'render');
      await compareTabs(baseline,candidate,`scope-${index}`);
      equal(`scope-${index}: complete original export`, await call(candidate,'reports'), await call(baseline,'reports'));
    }
    // Explicit identity changes without a state replacement; includes privileged -> restricted.
    for (const profile of profiles) {
      const settings = {profile,mode:'single',from:'2026-10-01',to:'2026-10-09',group:'all',tab:'groups'};
      await call(baseline,'configure',{...settings,state});await call(candidate,'configure',settings);
      await call(baseline,'render');await call(candidate,'render');
      await compareTabs(baseline,candidate,`identity-${profile.role}`);
    }
    // Save-time concurrency checks must read the fresh mutation source even when state remains old.
    const changed = structuredClone(state);
    changed.events.push({id:'new-attendance',type:'group_daily_edit',taskId:'group:g01',groupId:'g01',mode:'single',date:'2026-10-02',at:at(10),actor:'组长',after:{leader:'新组长',total:12,headcount:4.5}});
    for(const page of [baseline,candidate])await call(page,'configure',{profile:profiles[0],mode:'single',group:'g01',from:'2026-10-02',to:'2026-10-02',state});
    await call(candidate,'currentGroupDaily');
    const mutationRows = await candidate.evaluate(source => window.__overviewTest.groupDaily(source,'2026-10-02'), changed);
    equal('save-time fresh source bypasses current-state daily cache',mutationRows,await baseline.evaluate(source => window.__overviewTest.groupDaily(source,'2026-10-02'),changed));
    equal('save-time row includes newest edit id',mutationRows.find(row=>row.groupId==='g01').latestEditId,'new-attendance');
    changed.events.push({id:'new-release',taskId:'g01-accepted',type:'admin_release',at:at(10),actor:'管理员',actorRole:'admin'});
    changed.events.push({id:'new-delete',taskId:'g01-midnight',type:'task_deleted',at:at(10),actor:'管理员',actorRole:'admin'});
    changed.events.push({id:'new-tid',taskId:'g01-rework',type:'metadata_edit',at:at(10),actor:'管理员',actorRole:'admin',before:{tid:'TID-g01-rework'},after:{tid:'CORRECTED-TID'}});
    for (const page of [baseline,candidate]) {await call(page,'configure',{state:changed,from:'',to:'',group:'all',tab:'groups'});await call(page,'render');}
    await compareTabs(baseline,candidate,'new state: attendance/release/deletion/TID correction');
    equal('updated state: original complete export',await call(candidate,'reports'),await call(baseline,'reports'));
    await call(candidate,'preserveDrafts');
    const drafts = await call(candidate,'drafts');
    await call(candidate,'render');
    for (const tab of ['movies','daily','people','groups','people','groups']) await call(candidate,'select',tab);
    equal('overview rerenders and lazy tab navigation preserve draft DOM and values',await call(candidate,'drafts'),drafts);
    await call(candidate,'resetCalls');await call(candidate,'render');
    const repeatCalls = await call(candidate,'calls');
    equal('warm repeated render visits group panel only',repeatCalls.renders,{renderGroupProgress:1});
    equal('warm repeated render reuses report and daily aggregation',repeatCalls.reports.filter(call=>['build','groupDaily','annotationContributors'].includes(call.name)),[]);
    for(let day=1;day<=18;day++){
      const settings={from:at(day).slice(0,10),to:at(day).slice(0,10),tab:'groups'};
      for(const page of [baseline,candidate]){await call(page,'configure',settings);await call(page,'render');}
      equal(`cache pressure day ${day}: all cards and group rows`,await snapshot(candidate,'groups'),await snapshot(baseline,'groups'));
      assert.ok(await call(candidate,'cacheSize')<=12,'cache remains bounded to twelve entries');
    }
    checks.push('date-scope cache remains bounded to twelve entries through eighteen date changes');
    for(const page of [baseline,candidate]){await call(page,'configure',{from:'2026-10-01',to:'2026-10-09',tab:'groups'});await call(page,'render');}
    await compareTabs(baseline,candidate,'revisit scope after cache eviction');
    for(const [key,expected] of [['Home','groups'],['ArrowRight','movies'],['ArrowRight','daily'],['End','people'],['ArrowRight','groups'],['ArrowLeft','people']]){
      for(const page of [baseline,candidate])await page.evaluate(key=>{const selected=document.querySelector('[role="tab"][aria-selected="true"]');selected.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));},key);
      equal(`keyboard ${key}: ${expected} card/table/panel equality`,await snapshot(candidate,expected),await snapshot(baseline,expected));
      equal(`keyboard ${key}: selected tab`,(await snapshot(candidate,expected)).selected,[expected]);
    }
    // syncShared can update state while an unsaved form delays the normal render.
    // Opening a lazy panel must refresh its header too; compare with a fully
    // rendered baseline oracle and retain the exact unsaved form nodes.
    for(const page of [baseline,candidate]){await call(page,'configure',{...initial,group:'g01'});await call(page,'render');}
    const staleBefore=await snapshot(candidate,'groups'),deferredState=structuredClone(state);
    deferredState.tasks.push({id:'synced-extra',tid:'SYNCED-TID',groupId:'g01',mode:'single',movie:'跨组共同影片',date:'2026-10-03',createdAt:at(3),createdBy:'管理员'});
    deferredState.events.push({id:'synced-extra-dispatch',taskId:'synced-extra',type:'dispatch',at:at(3),actor:'管理员',actorRole:'admin'});
    equal('deferred state fixture starts at fourteen active tasks',staleBefore.cards.metricTotal,'14');
    const deferredDrafts=await call(candidate,'drafts');
    await call(candidate,'configure',{state:deferredState});
    equal('deferred sync does not eagerly discard or redraw existing header',(await snapshot(candidate,'groups')).cards,staleBefore.cards);
    await call(baseline,'configure',{state:deferredState});await call(baseline,'render');
    for(const tab of ['movies','groups']){
      await call(baseline,'select',tab);await call(candidate,'select',tab);
      equal(`deferred sync then ${tab}: header and active panel use one updated state`,await snapshot(candidate,tab),await snapshot(baseline,tab));
      equal(`deferred sync then ${tab}: header counts new task`,(await snapshot(candidate,tab)).cards.metricTotal,'15');
    }
    equal('deferred state tab refresh retains unsaved draft node identities and values',await call(candidate,'drafts'),deferredDrafts);
    await call(candidate,'configure',{from:'2026-10-03',to:'2026-10-03',group:'all'});
    await call(baseline,'configure',{from:'2026-10-03',to:'2026-10-03',group:'all'});await call(baseline,'render');
    for(const page of [baseline,candidate])await call(page,'select','daily');
    equal('deferred scope change then daily: header and panel use one date/group scope',await snapshot(candidate,'daily'),await snapshot(baseline,'daily'));
    equal('deferred scope tab refresh retains unsaved draft node identities and values',await call(candidate,'drafts'),deferredDrafts);
    equal('synthetic input history remains unchanged',JSON.stringify(state),original);
    let performanceResult;
    if(process.env.BENCHMARK){
      const large=largeFixture(state);
      let oldTimes,baselineReusedFrom;
      if(process.env.BASELINE_BENCHMARK_PATH){
        const previous=JSON.parse(fs.readFileSync(process.env.BASELINE_BENCHMARK_PATH,'utf8'));
        for(const file of [baselineApp,baselineReports])assert.equal(previous.sourceHashes[file],crypto.createHash('sha256').update(read(file)).digest('hex'),'Reused performance baseline must match the immutable production source');
        assert.equal(previous.performance.tasks,large.tasks.length);assert.equal(previous.performance.events,large.events.length);
        assert.equal(previous.performance.samplesPerOperation,3);assert.equal(previous.browser,path.basename(browserPath));
        oldTimes=previous.performance.baseline;baselineReusedFrom=path.resolve(process.env.BASELINE_BENCHMARK_PATH);
        trace('benchmark baseline: reusing source-verified previous samples');
      }else{trace('benchmark baseline');oldTimes=await measure(baseline,large);}
      trace('benchmark candidate');const newTimes=await measure(candidate,large);
      performanceResult={tasks:large.tasks.length,events:large.events.length,samplesPerOperation:3,measurement:'synchronous production render + real DOM updates in the same installed browser; excludes network, fixture transfer and browser startup; each iteration begins with a fresh state identity, subsequent operations keep that state and profile',...(baselineReusedFrom?{baselineReusedFrom}:{}),baseline:oldTimes,candidate:newTimes};
    }
    const report = {ok:true,assertions:checks.length,tasks:state.tasks.length,events:state.events.length,browser:path.basename(browserPath),intentionalMetricChanges:changedMetricIds,metricRegression:'scripts/verify-rejection-split.cjs',network:'blocked; application init and store are never run',initialReportCalls:firstCalls.reports.reduce((acc,call)=>{const key=call.name+(call.kind?':'+call.kind:'');acc[key]=(acc[key]||0)+1;return acc;},{}),sourceHashes:Object.fromEntries([baselineApp,baselineReports,'app.js','reports.js'].map(file=>[file,crypto.createHash('sha256').update(read(file)).digest('hex')])),...(performanceResult?{performance:performanceResult}:{}),checks};
    if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
