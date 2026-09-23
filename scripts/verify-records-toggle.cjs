'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {harness,fixture,extract,source}=require('./verify-workbench-pagination.cjs');
const Flow=require('../group-workbench/workflow.js');
const Reports=require('../group-workbench/reports.js');
const root=path.join(__dirname,'..'),cases=[];
const plain=value=>JSON.parse(JSON.stringify(value));
const check=(label,actual,expected)=>{assert.deepEqual(plain(actual),plain(expected),label);cases.push(label);};
function combinedFixture() {
  const out={version:3,tasks:[],events:[],batches:[],preferences:{}};
  for(const mode of ['single','multi']) {
    const input=fixture(125);
    input.tasks.forEach((task,index)=>{const old=task.id;task.id=mode+'-'+old;task.tid=mode+'-'+task.tid;task.movie=index<90?'筛选影片甲':'筛选影片乙';task.mode=mode;task.groupId=mode==='single'?'g01':'g06';input.events.filter(event=>event.taskId===old).forEach(event=>{event.taskId=task.id;event.id=mode+'-'+event.id;});
      if(index>=100)input.events.push({id:task.id+'-pass',taskId:task.id,type:'qc_pass',at:'2026-09-22T02:00:00Z',workflowVersion:3,actor:'质检人员'},{id:task.id+'-accepted',taskId:task.id,type:'acceptance_pass',at:'2026-09-22T03:00:00Z',workflowVersion:3,actor:'验收人员'});
    });
    out.tasks.push(...input.tasks);out.events.push(...input.events);
  }return out;
}
function setup() {
  const h=harness(combinedFixture()),c=h.c,n=h.nodes,frames=[],documentHandlers=new Map();
  c.profile={role:'admin',name:'admin'};c.recordsGateOpen=false;c.recordsCollapsedScope='';
  c.window.WorkbenchReports=Reports;c.refreshState=()=>true;c.renderTimeline=id=>{n.get('timelinePanel').innerHTML=`timeline:${id}`;};
  c.qsa=()=>[];c.qs=(selector)=>selector.includes('data-status="all"')?{focus(){h.focusedAll=true;}}:null;
  c.BATCH_FIRST=200;c.BATCH_NEXT=400;c.requestAnimationFrame=callback=>frames.push(callback);
  c.VIEW_META={records:{id:'recordsView',title:'全部任务'},overview:{id:'overviewView',title:'小组总览'}};
  c.currentView='records';c.document.body={dataset:{}};c.document.addEventListener=(type,fn)=>documentHandlers.set(type,fn);
  c.placeScopeDateControl=()=>{};c.renderCurrentView=()=>{if(c.currentView==='records')c.renderRecords();};
  c.selectedRange=()=>({dateFrom:n.get('scopeDateFrom').value,dateTo:n.get('scopeDateTo').value});
  c.scopeRangeKey=()=>`${n.get('scopeDateFrom').value}|${n.get('scopeDateTo').value}`;
  c.OVERVIEW_BUCKETS={active:{label:'处理中',test:task=>!['accepted','rejected'].includes(task.status)}};
  vm.runInContext(['inDateRange','validScopeRange','recordBaseTasks','matchesStatus','matchesStatusList','matchesQcRound','matchesOverviewBucket','selectRecordState','renderRowsBatched','activateView','openOverviewBucket','openWholeMovie','bindModuleEvents'].map(extract).join('\n'),c);
  c.bindModuleEvents();
  return Object.assign(h,{frames,documentHandlers});
}
async function main() {
  const h=setup(),c=h.c,n=h.nodes,initial=JSON.stringify(c.state);
  const hidden=id=>n.get(id).classList.contains('hidden');
  const filters=()=>({movie:c.multiGet('recordMovie'),search:n.get('recordSearch').value,dateMode:n.get('recordDateMode').value,from:n.get('recordDateFrom').value,to:n.get('recordDateTo').value});
  for(const mode of ['single','multi']) {
    c.activeMode=mode;c.recordsGateOpen=false;c.recordsCollapsedScope='';c.multiSet('recordMovie',[]);c.multiSet('recordStatus',[]);n.get('recordSearch').value='';n.get('recordQcRound').value='all';n.get('scopeGroup').value='all';
    c.renderRecords();check(`${mode}: initial list is collapsed`,[c.recordsExpanded(),hidden('recordList'),hidden('recordBodyPager'),hidden('timelinePanel')],[false,true,true,true]);
    check(`${mode}: collapsed model and row DOM are empty`,[c.listModel('records').total,n.get('recordBody').innerHTML],[0,'']);
    c.selectRecordState('all');check(`${mode}: first all click expands scoped tasks`,[c.recordsExpanded(),c.listModel('records').total,c.listModel('records').pageRows.length],[true,125,50]);
    assert(c.listModel('records').rows.every(task=>task.mode===mode));assert.match(n.get('recordStatusBoard').innerHTML,/data-status="all" aria-expanded="true"/);
    c.listModel('records').page=3;c.selectedTimelineTaskId=c.state.tasks.find(task=>task.mode===mode).id;c.renderRecords();check(`${mode}: third page is real last page`,c.listModel('records').pageRows.length,25);
    const editor=n.get('taskEditor'),form={id:'retained-form',note:'修改说明草稿',tid:'尚未保存的新TID'};editor.childNodes=[form];editor.classList.remove('hidden');
    c.selectRecordState('all');check(`${mode}: second all click collapses and clears pagination rows`,[c.recordsExpanded(),c.listModel('records').page,c.listModel('records').total,c.listModel('records').pageRows.length],[false,1,0,0]);
    check(`${mode}: table, pager and timeline hidden together`,[hidden('recordList'),hidden('recordBodyPager'),hidden('timelinePanel')],[true,true,true]);
    check(`${mode}: row DOM and render token removed`,[n.get('recordBody').innerHTML,Object.hasOwn(n.get('recordBody').dataset,'renderToken')],['',false]);
    check(`${mode}: task editor object and draft survive`,[editor.childNodes[0]===form,form.note,form.tid,hidden('taskEditor')],[true,'修改说明草稿','尚未保存的新TID',false]);
    assert.match(n.get('recordStatusBoard').innerHTML,/data-status="all" aria-expanded="false"/);assert.match(n.get('recordSummary').textContent,/明细已收起/);
    c.renderRecords();c.renderRecords();check(`${mode}: repeated same-scope sync/render stays collapsed`,c.recordsExpanded(),false);
    c.selectRecordState('all');check(`${mode}: third click reopens page one`,[c.recordsExpanded(),c.listModel('records').page,c.listModel('records').pageRows.length],[true,1,50]);
    check(`${mode}: timeline selection restored without touching editor`,[n.get('timelinePanel').innerHTML,editor.childNodes[0]===form],[`timeline:${c.selectedTimelineTaskId}`,true]);

    c.multiSet('recordMovie',['筛选影片甲']);n.get('recordSearch').value='TID-';n.get('recordDateMode').value='range';n.get('recordDateFrom').value='2026-09-21';n.get('recordDateTo').value='2026-09-23';c.renderRecords();
    const remembered=plain(filters());check(`${mode}: movie/search/date still filter actual tasks`,c.listModel('records').total,90);
    c.selectRecordState('all');check(`${mode}: filtered list can be explicitly collapsed`,c.recordsExpanded(),false);check(`${mode}: collapse retains movie/search/date values`,filters(),remembered);
    const delayed=c.debounceListSearch(c.renderRecords,5);delayed({isComposing:false});await new Promise(resolve=>setTimeout(resolve,15));check(`${mode}: already queued search debounce cannot reopen same collapsed scope`,c.recordsExpanded(),false);
    c.state={...c.state,events:[...c.state.events]};c.renderRecords();check(`${mode}: a cloud state revision does not reopen collapsed scope`,c.recordsExpanded(),false);
    n.get('recordSearch').value='TID-1';c.renderRecords();check(`${mode}: actual search change restores automatic filtered expansion`,c.recordsExpanded(),true);assert(c.listModel('records').total>0&&c.listModel('records').total<90);
    c.selectRecordState('all');n.get('scopeGroup').value=mode==='single'?'g01':'g06';c.renderRecords();check(`${mode}: real scope change discards stale collapse override`,c.recordsExpanded(),true);
    c.multiSet('recordMovie',[]);n.get('recordSearch').value='';n.get('recordDateMode').value='all';c.selectRecordState('accepted');check(`${mode}: status filter shows accepted rows`,c.listModel('records').total,25);
    c.selectRecordState('all');check(`${mode}: all after another status opens all before toggling`,[c.recordsExpanded(),c.multiGet('recordStatus'),c.listModel('records').total],[true,[],125]);
    c.selectRecordState('all');check(`${mode}: next all now collapses`,c.recordsExpanded(),false);
    c.selectRecordState('pending_qc','1');check(`${mode}: explicit status/round reopens correctly`,[c.recordsExpanded(),c.listModel('records').total,n.get('recordQcRound').value],[true,100,'1']);
    c.selectRecordState('all');check(`${mode}: all first clears previous round and stays open`,[c.recordsExpanded(),n.get('recordQcRound').value],[true,'all']);
    c.selectRecordState('all');check(`${mode}: all then closes cleared-round view`,c.recordsExpanded(),false);
    c.openOverviewBucket('all',mode==='single'?'g01':'g06');check(`${mode}: overview all drill explicitly opens after collapse`,[c.recordsExpanded(),c.listModel('records').total],[true,125]);
    c.selectRecordState('all');h.documentHandlers.get('click')({target:{closest:()=>({dataset:{action:'group-details',groupId:mode==='single'?'g01':'g06'}})}});check(`${mode}: group-name drill also reopens after collapse`,[c.recordsExpanded(),c.listModel('records').total],[true,125]);
    c.selectRecordState('all');c.openWholeMovie('筛选影片甲');check(`${mode}: whole-film drill restores its own filtered list`,[c.recordsExpanded(),c.listModel('records').total],[true,90]);
  }

  c.multiSet('recordMovie',[]);n.get('recordSearch').value='';c.selectRecordState('accepted');c.selectRecordState('all');
  c.renderRowsBatched(n.get('recordBody'),Array(500).fill('<tr><td>queued</td></tr>'),1,'empty');check('synthetic pending chunk exists',h.frames.length,1);
  c.selectRecordState('all');h.frames.shift()();check('a queued rendering chunk cannot restore rows after collapse',n.get('recordBody').innerHTML,'');
  check('all toggles and filters perform no writes to task history',JSON.stringify(c.state),initial);
  check('no mutation transaction was submitted',h.commits.length,0);
  check('all toggle restores keyboard focus after button reconstruction',h.focusedAll,true);
  const html=fs.readFileSync(path.join(root,'group-workbench/index.html'),'utf8');assert.equal((html.match(/id="recordList"/g)||[]).length,1);assert.match(html,/id="taskEditor"/);
  const regressions=[];
  for(const script of ['verify-workbench-pagination.cjs','verify-acceptance-accuracy-ui.cjs','verify-first-qc-date.cjs']) {
    const run=spawnSync(process.execPath,[path.join(__dirname,script)],{encoding:'utf8',env:{...process.env,RESULT_PATH:''}});assert.equal(run.status,0,`${script}: ${run.stderr||run.stdout}`);const result=JSON.parse(run.stdout);regressions.push({script,ok:result.ok,checks:Array.isArray(result.checks)?result.checks.length:result.checks});
  }
  const sourceHashes=Object.fromEntries(['app.js','index.html','reports.js','workflow.js','shared-store.js'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'group-workbench',file))).digest('hex')]));
  const result={ok:true,checks:cases.length,cases,regressions,sourceHashes,productionFunctions:['recordsExpanded','selectRecordState','renderRecords','listModel','listPage','renderListPager','renderRowsBatched','recordBaseTasks','activateView','openOverviewBucket','openWholeMovie','bindModuleEvents']};
  if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
