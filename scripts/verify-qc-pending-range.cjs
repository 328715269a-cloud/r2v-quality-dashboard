'use strict';

// Frozen synthetic histories, the real Flow projection and extracted UI helpers.
// No browser, API, production data, credentials or network access.
process.env.TZ='Asia/Shanghai';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createHash}=require('node:crypto');
const Flow=require('../group-workbench/workflow.js');
const sourcePath=path.resolve(__dirname,'../group-workbench/app.js');
const source=fs.readFileSync(sourcePath,'utf8'),lines=source.split(/\r?\n/);
let checks=0,scenarios=0;
function equal(actual,expected,label){assert.equal(actual,expected,label);checks++;}
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function extract(name){
  const start=lines.findIndex(line=>line.startsWith(`  function ${name}(`));assert.notEqual(start,-1,`Production helper ${name} exists`);
  if(lines[start].trimEnd().endsWith('}'))return lines[start];
  const end=lines.findIndex((line,index)=>index>start&&/^  }\s*$/.test(line));assert(end>start,`Production helper ${name} closes`);
  return lines.slice(start,end+1).join('\n');
}
const helpers=['localDateString','acceptanceEventDate','selectedRange','validScopeRange','inDateRange','singleScopeDate',
  'canViewAllGroups','canViewGroup','selectedGroup','eventsForTask','liveEvents','taskSnapshot','taskWithSnapshot','taskIndex','allTasks',
  'pendingReworkSplit','renderTodayMetrics'].map(extract).join('\n');
const at=(day,time='09:00:00')=>`2026-10-${String(day).padStart(2,'0')}T${time}+08:00`;
const event=(type,day=20,extra={})=>({type,at:at(day),...extra});
const submit=(day=20,extra={})=>event('submit',day,{actor:'合成标注',actorRole:'annotation',assignee:'合成标注',...extra});
const claim=(day=20,extra={})=>event('claim',day,{actor:'合成标注',actorRole:'annotation',assignee:'合成标注',...extra});
const fail=(day=20)=>event('qc_fail',day,{pLevel:'P1',tags:['命名/ID对齐错误'],note:'合成返修'});
function fixture(specs){
  const state={version:3,tasks:[],events:[],batches:[]};
  specs.forEach(({id,tid=id,mode='single',groupId=mode==='single'?'g01':'g06',events=[]})=>{
    state.tasks.push({id,tid,mode,groupId,movie:'待质检区间合成验证',date:'2026-09-01',createdAt:'2026-09-01T01:00:00Z'});
    events.forEach((item,index)=>state.events.push({id:`${id}-${index}`,taskId:id,workflowVersion:3,actor:'合成质检',actorRole:'qc',...item}));
  });
  return freeze(state);
}
function harness(initial){
  const controls={scopeDateFrom:{value:''},scopeDateTo:{value:''},scopeGroup:{value:'all'}},writes=new Map();
  let current=initial,original=JSON.stringify(initial);
  const context=vm.createContext({window:{WorkbenchFlow:Flow},state:current,activeMode:'single',profile:{role:'admin'},
    eventIndexes:new WeakMap(),snapshotCache:new WeakMap(),$:id=>controls[id],setText:(id,value)=>writes.set(id,value),
    countFirstRejections:()=>0,countRangeQcPass:()=>0,countRangeAcceptance:()=>0,countRangeReworkTasks:()=>0,countDayActors:()=>0,countRangeRejected:()=>0});
  vm.runInContext(helpers,context,{filename:sourcePath});
  function scope({from='2026-10-20',to=from,mode='single',groupId='all',user={role:'admin'}}={}){
    controls.scopeDateFrom.value=from;controls.scopeDateTo.value=to;controls.scopeGroup.value=groupId;context.activeMode=mode;context.profile=user;
  }
  return{context,scope,writes,
    projection(id){const task=current.tasks.find(row=>row.id===id);return Flow.project(task,current.events);},
    check(label,qcPending,reworkPending=0,options={}){
      scenarios++;scope(options);const result=context.pendingReworkSplit();
      equal(result.qcPending,qcPending,`${label}: pending QC`);equal(result.reworkPending,reworkPending,`${label}: pending rework`);
      writes.clear();context.renderTodayMetrics([{initialAnnotationTIDs:7,qcPassActions:999}]);
      equal(writes.get('metricTodayQcPending'),qcPending,`${label}: real overview card`);
      equal(writes.get('metricTodayReworkPending'),reworkPending,`${label}: real rework card`);
      equal(writes.get('metricTodayAnnotation'),7,`${label}: first-completion metric remains independent`);
      equal(JSON.stringify(current),original,`${label}: immutable input`);
    },
    setState(next){current=next;original=JSON.stringify(next);context.state=next;}
  };
}

for(const mode of ['single','multi']){
  const first=harness(fixture([{id:'first',mode,events:[claim(),submit()]}]));
  first.check(`${mode}: current-day initial submission`,1,0,{mode});
  equal(first.projection('first').status,'pending_qc',`${mode}: real first-round state`);
  equal(first.projection('first').qcRound,1,`${mode}: real first round`);
  equal(first.writes.get('metricTodayQcPendingHint').includes('首交待质检'),false,`${mode}: obsolete first-only hint removed`);
  for(const round of [2,3,4]){
    const chain=[claim(19),submit(19)];
    for(let i=2;i<=round;i++)chain.push(fail(19),submit(i===round?20:19,{submissionKind:'rework'}));
    const h=harness(fixture([{id:'round-'+round,mode,events:chain}]));
    equal(h.projection('round-'+round).status,'pending_reqc',`${mode}: round ${round} real recheck state`);
    equal(h.projection('round-'+round).qcRound,round,`${mode}: round ${round} retained`);
    h.check(`${mode}: round ${round} enters today's pending QC`,1,0,{mode});
    h.check(`${mode}: round ${round} does not remain on the old submission date`,0,0,{mode,from:'2026-10-19'});
    h.check(`${mode}: round ${round} counts once across its whole history`,1,0,{mode,from:'2026-10-19',to:'2026-10-20'});
  }
  const acceptance=harness(fixture([{id:'acceptance-rework',mode,events:[claim(18),submit(18),event('qc_pass',18),
    event('acceptance_fail',19,{acceptanceInspection:'uninspected',acceptanceBatchId:'synthetic',note:'随批复查'}),
    event('acceptance_route',19,{route:'annotation'}),submit(20,{submissionKind:'rework'})]}]));
  equal(acceptance.projection('acceptance-rework').status,'pending_reqc',`${mode}: acceptance rework actually re-enters QC`);
  acceptance.check(`${mode}: acceptance return and resubmit enters current QC`,1,0,{mode});
  acceptance.check(`${mode}: earlier QC pass does not hide a current recheck`,1,0,{mode,from:'2026-10-18',to:'2026-10-20'});
  const future=harness(fixture([{id:'moved',mode,events:[claim(),submit(),fail(21),submit(22,{submissionKind:'rework'})]}]));
  future.check(`${mode}: any earlier submit is insufficient`,0,0,{mode});
  future.check(`${mode}: only latest submit date owns the pending task`,1,0,{mode,from:'2026-10-22'});
  future.check(`${mode}: all-date queue counts the task once`,1,0,{mode,from:'',to:''});
}

const finished=harness(fixture([
  {id:'passed',events:[claim(),submit(),event('qc_pass')]},
  {id:'rework',events:[claim(),submit(),fail(21)]},
  {id:'returned-resubmitted',events:[claim(),submit(),fail(),submit(21)]},
  {id:'direct-rejected',events:[claim(),submit(),event('qc_reject')]},
  {id:'legacy-rejected',events:[claim(),submit(),event('qc_fail',20,{note:'[质检拒绝] 无法继续'})]},
  {id:'confirmed-rejected',events:[claim(),event('annotator_reject'),event('reject_confirm')]},
  {id:'rejection-pending',events:[claim(),event('annotator_reject')]},
  {id:'accepted',events:[claim(),submit(),event('qc_pass'),event('acceptance_pass')]},
  {id:'acceptance-awaiting-route',events:[claim(),submit(),event('qc_pass'),event('acceptance_fail')]},
  {id:'qc-self-rework',events:[claim(),submit(),event('qc_pass'),event('acceptance_fail'),event('acceptance_route',20,{route:'qc'})]},
  {id:'acceptance-rework',events:[claim(),submit(),event('qc_pass'),event('acceptance_fail'),event('acceptance_route',20,{route:'annotation'})]}
]));
finished.check('current passed/rejected/return-processing states are not pending QC',0,1);
finished.check('rework resubmitted tomorrow leaves rework and appears in QC tomorrow',1,0,{from:'2026-10-21'});
finished.check('rework retains original first-submit date despite later failure',1,1,{to:'2026-10-21'});
equal(finished.projection('acceptance-rework').status,'acceptance_rework','acceptance rework fixture is genuine');
// Its last QC verdict is pass, so the existing first-submit/last-QC rework rule remains unchanged.

const scopes=harness(fixture([
  {id:'single-1',events:[submit()]},{id:'single-2',groupId:'g02',events:[submit(19),fail(19),submit()]},
  {id:'multi-1',mode:'multi',events:[submit()]},{id:'multi-2',mode:'multi',groupId:'g07',events:[submit(19),fail(19),submit()]}
]));
for(const [mode,first,second]of [['single','g01','g02'],['multi','g06','g07']]){
  scopes.check(`${mode}: all groups`,2,0,{mode});scopes.check(`${mode}: selected group`,1,0,{mode,groupId:second});
  scopes.check(`${mode}: acceptance sees both groups`,2,0,{mode,user:{role:'acceptance'}});
  for(const role of ['qc','annotation'])scopes.check(`${mode}: ${role} remains group-locked`,1,0,{mode,groupId:second,user:{role,groupId:first}});
}
scopes.check('single-group identity cannot read multi queue',0,0,{mode:'multi',user:{role:'qc',groupId:'g01'}});

const lifecycle=harness(fixture([
  {id:'released',events:[claim(19),submit(19),fail(19),event('admin_release')]},
  {id:'restarted',events:[claim(19),submit(19),fail(19),event('admin_release'),claim(21),submit(21)]},
  {id:'deleted',events:[claim(),submit(),event('task_deleted')]},
  {id:'active',events:[claim(),submit()]}
]));
lifecycle.check('release/deletion removes obsolete waiting tasks',1);
lifecycle.check('new lifecycle owns the new submission date',1,0,{from:'2026-10-21'});
lifecycle.check('released submission date is never revived',0,0,{from:'2026-10-19'});
equal(lifecycle.projection('released').submittedAt,'','release clears projected submitted timestamp');
equal(lifecycle.projection('restarted').qcRound,1,'new lifecycle starts at first QC');

const reassigned=harness(fixture([{id:'ignored',events:[claim(19),submit(19),fail(19),
  event('claim',20,{assignmentKind:'rework_transfer',fromAssignee:'合成标注',assignee:'接手标注'}),
  submit(21,{actor:'接手标注',assignee:'接手标注'}),
  submit(22,{actor:'合成标注',assignee:'合成标注'}),
  submit(23,{actor:'接手标注',assignee:'接手标注'})]}]));
equal(reassigned.projection('ignored').legacyConflicts.length,2,'real Flow ignores old-owner and duplicate stale submits');
equal(reassigned.projection('ignored').submittedAt,at(21),'ignored records do not replace valid submittedAt');
reassigned.check('ignored old submits do not move pending QC away from valid date',1,0,{from:'2026-10-21'});
reassigned.check('ignored old-owner submit day adds no task',0,0,{from:'2026-10-22'});
reassigned.check('ignored current-owner duplicate day adds no task',0,0,{from:'2026-10-23'});

const dedup=harness(fixture([
  {id:'same-tid-a',tid:'SHARED',events:[submit(19),fail(19),submit(),submit()]},
  {id:'same-tid-b',tid:' SHARED ',events:[submit()]},
  {id:'different',events:[submit()]},
  {id:'deleted-tid',tid:'SHARED',events:[submit(),event('task_deleted')]}
]));
dedup.check('same TID and repeated submit events count once; deleted duplicate excluded',2);
dedup.check('range union does not add old submissions',2,0,{from:'2026-10-19',to:'2026-10-20'});

const migrated=harness(fixture([
  {id:'legacy-first',events:[submit(20,{workflowVersion:2,targetStatus:'annotation_done'})]},
  {id:'legacy-rework',events:[submit(19),fail(19),submit(20,{workflowVersion:2,targetStatus:'annotation_rework_done'})]}
]));
equal(migrated.projection('legacy-first').status,'pending_qc','legacy submitted state migrates to current first QC');
equal(migrated.projection('legacy-rework').status,'pending_reqc','legacy rework submitted state migrates to current recheck');
equal(migrated.projection('legacy-rework').submittedAt,at(20),'legacy migration preserves actual resubmission timestamp');
migrated.check('legacy submitted states use projected submission dates without synthetic events',2);
migrated.check('legacy first submission does not retain a later current recheck on old date',0,0,{from:'2026-10-19'});

const stamps=['2026-10-19T15:59:59.999Z','2026-10-19T16:00:00.000Z','2026-10-20T15:59:59.999Z','2026-10-20T16:00:00.000Z'];
const boundaries=harness(fixture(stamps.map((stamp,i)=>({id:'boundary-'+i,events:[submit(20,{at:stamp})]})).concat([
  {id:'invalid',events:[submit(20,{at:'invalid'})]},{id:'empty',events:[submit(20,{at:''})]},{id:'missing',events:[submit(20,{at:undefined})]}
])));
boundaries.check('Beijing day inclusive midnight boundaries',2);
boundaries.check('open lower date bound',3,0,{from:'',to:'2026-10-20'});
boundaries.check('open upper date bound',3,0,{from:'2026-10-20',to:''});
boundaries.check('all dates excludes invalid submitted timestamps',4,0,{from:'',to:''});
const priorZone=process.env.TZ;try{process.env.TZ='America/Los_Angeles';boundaries.check('QC pending date remains Beijing outside China timezone',2);}finally{process.env.TZ=priorZone;}
boundaries.scope({from:'2026-10-21',to:'2026-10-20'});equal(boundaries.context.validScopeRange(),false,'reversed date range invalid');
boundaries.context.renderTodayMetrics(null);equal(boundaries.writes.get('metricTodayQcPending'),'—','invalid range clears pending card');

const refresh=harness(fixture([{id:'updated',events:[submit(19),fail(19)]}]));
refresh.check('before resubmit current task is rework',0,1,{from:'2026-10-19'});
refresh.setState(fixture([{id:'updated',events:[submit(19),fail(19),submit()]}]));
refresh.check('new synchronized snapshot enters current waiting queue',1);
refresh.check('old failure date no longer retains resubmitted task as rework',0,0,{from:'2026-10-19'});
const result={ok:true,checks,scenarios,source:'group-workbench/app.js',sourceSha256:{
  'group-workbench/app.js':createHash('sha256').update(source).digest('hex'),
  'group-workbench/workflow.js':createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../group-workbench/workflow.js'))).digest('hex')},
  coverage:['initial and second/third/fourth QC rounds','acceptance rework resubmission','latest effective submission date and current status','rework original first-submission date preserved',
    'single/multi, group and role isolation','release/deletion and ignored stale operations','legacy submitted-state migration','TID and event deduplication','Beijing dates, invalid ranges, snapshot refresh and immutable histories']};
if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
