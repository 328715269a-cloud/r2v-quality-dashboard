'use strict';
const assert = require('node:assert/strict');
const Reports = require('../group-workbench-beta/reports.js');
const Flow = require('../group-workbench-beta/workflow.js');
const IO = require('../group-workbench-beta/data-io.js');
const rawTasks = [
  { id:'a', tid:'000001', movie:'原始片名', date:'2026-09-08', groupId:'g1', mode:'single', createdAt:'2026-09-08T03:00:00Z', extra:'保留\n换行' },
  { id:'b', tid:'000002', movie:'修正影片', date:'2026-09-09', groupId:'g2', mode:'single', createdAt:'2026-09-09T03:00:00Z' },
  { id:'c', tid:'900001', movie:'多镜头保密影片', date:'2026-09-09', groupId:'g6', mode:'multi', createdAt:'2026-09-09T03:00:00Z' },
  { id:'d', tid:'000004', movie:'未操作影片', date:'2026-09-10', groupId:'g1', mode:'single', createdAt:'2026-09-09T17:00:00Z' }
];
const tasks = [
  { ...rawTasks[0], tid:'000009', movie:'修正影片', status:'accepted', statusLabel:'验收通过', round:2, qcRound:2, acceptanceRound:1, assignee:'张明', originalAssignee:'成员01A', rejectionReason:'带,逗号\n多行说明', qcPackageId:'p1' },
  { ...rawTasks[1], status:'rejected', assignee:'李明' },
  { ...rawTasks[3], status:'unclaimed' }
];
let counter = 0;
function ev(taskId,type,at,details={}) { return {id:`e${++counter}`,taskId,type,at,actor:'操作员',...details}; }
const events = [
  ev('a','dispatch','2026-09-08T03:00:00Z'),
  ev('b','dispatch','2026-09-09T03:00:00Z'),
  ev('c','dispatch','2026-09-09T03:00:00Z'),
  ev('a','submit','2026-09-09T17:00:00Z',{submissionKind:'initial',round:1,note:'凌晨操作\n完整记录'}),
  ev('a','package_built','2026-09-09T17:01:00Z',{stage:'qc',packageId:'p1',packageName:'首批',tidAtEvent:'000001',movieAtEvent:'原始片名'}),
  ev('b','package_built','2026-09-09T17:01:00Z',{stage:'qc',packageId:'p1',packageName:'首批',tidAtEvent:'000002',movieAtEvent:'修正影片'}),
  ev('a','package_claimed','2026-09-09T17:02:00Z',{stage:'qc',packageId:'p1'}),
  ev('b','package_claimed','2026-09-09T17:02:00Z',{stage:'qc',packageId:'p1'}),
  ev('a','qc_fail','2026-09-09T17:03:00Z',{pLevel:'P1',tags:['补标缺失','备注不完整'],note:'首检打回'}),
  ev('a','submit','2026-09-09T17:04:00Z',{submissionKind:'rework',round:2}),
  ev('a','qc_pass','2026-09-09T17:05:00Z'),
  ev('a','qc_pass','2026-09-09T17:06:00Z'),
  ev('a','acceptance_fail','2026-09-09T17:07:00Z'),
  ev('a','qc_repair_done','2026-09-09T17:08:00Z'),
  ev('a','acceptance_pass','2026-09-09T17:09:00Z'),
  ev('a','acceptance_pass','2026-09-10T17:09:00Z'),
  ev('b','reject_confirm','2026-09-09T17:10:00Z'),
  ev('b','reject_confirm','2026-09-10T17:10:00Z'),
  ev('a','metadata_edit','2026-09-10T17:11:00Z',{before:{tid:'000001',movie:'原始片名'},after:{tid:'000009',movie:'修正影片'}}),
  ev('c','package_built','2026-09-09T17:01:00Z',{stage:'qc',packageId:'p2'}),
  ev('c','acceptance_pass','2026-09-10T17:12:00Z')
];
const batches = [
  {id:'allocation',kind:'import',taskIds:['a','b'],createdAt:'2026-09-08T03:00:00Z'},
  {id:'p1',kind:'handoff',stage:'qc',packageName:'首批',taskIds:['a','b'],createdAt:'2026-09-09T17:01:00Z',createdBy:'李组长'},
  {id:'p2',kind:'handoff',stage:'qc',taskIds:['c'],createdAt:'2026-09-09T17:01:00Z',createdBy:'多镜头负责人'},
  {id:'p3',kind:'handoff',stage:'acceptance',packageName:'分批送验',taskIds:['a'],createdAt:'2026-09-09T17:08:00Z',createdBy:'李组长'},
  {id:'mixed',kind:'handoff',stage:'qc',taskIds:['a','c'],tids:['000001','900001'],createdAt:'2026-09-09T17:11:00Z'}
];
const input = {
  state:{tasks:rawTasks,events,batches},tasks,
  statusMeta:{unclaimed:{label:'待标注'},annotating:{label:'待标注'},accepted:{label:'验收通过'},rejected:{label:'拒绝'}},
  groupLabel:id=>({g1:'1组',g2:'2组',g6:'6组'})[id],eventLabel:event=>`操作:${event.type}`,eventDetail:event=>event.note||'',
  localDate:value=>new Date(new Date(value).getTime()+8*3600000).toISOString().slice(0,10)
};
const original = JSON.stringify(input);
const result = Reports.build(input);
assert.equal(JSON.stringify(input),original,'reports must not alter tasks, events, or batch membership');
assert.deepEqual(Object.keys(result),['tasks','events','packages','movies','groups','daily']);
for (const report of Object.values(result)) {
  assert.equal(new Set(report.columns.map(column=>column.key)).size,report.columns.length,'column keys must be unique');
  assert.ok(report.columns.every(column=>column.label));
  for (const row of report.rows) assert.ok(report.columns.every(column=>Object.hasOwn(row,column.key)),`all columns have row values: ${JSON.stringify(row)}`);
}
assert.equal(result.tasks.rows.length,3);
assert.equal(result.tasks.rows[0].tid,'000009');
assert.equal(result.tasks.rows[0].firstQcDecision,'打回');
assert.equal(result.tasks.rows[0].firstQcPLevel,'P1');
assert.deepEqual(JSON.parse(result.tasks.rows[0].firstQcTagsJSON),['补标缺失','备注不完整']);
assert.equal(result.tasks.rows[0].firstQcNote,'首检打回');
assert.equal(result.tasks.rows[0].latestQcDecision,'通过');
assert.equal(result.tasks.rows[0].latestQcPLevel,'');
assert.equal(result.events.rows.find(event=>event.type==='qc_fail').pLevel,'P1');
assert.deepEqual(JSON.parse(result.events.rows.find(event=>event.type==='qc_fail').tagsJSON),['补标缺失','备注不完整']);
assert.equal(JSON.parse(result.tasks.rows[0].originalTaskJSON).tid,'000001');
assert.equal(JSON.parse(result.tasks.rows[0].originalTaskJSON).extra,'保留\n换行');
assert.equal(JSON.parse(result.tasks.rows[0].fullTimelineJSON).length,events.filter(event=>event.taskId==='a').length);
const oldSubmit = result.events.rows.find(event=>event.type==='submit');
assert.equal(oldSubmit.currentTid,'000009');
assert.equal(oldSubmit.atTimeTid,'000001');
assert.equal(oldSubmit.currentMovie,'修正影片');
assert.equal(oldSubmit.atTimeMovie,'原始片名','old events use original movie, never relabeled current movie');
assert.equal(oldSubmit.localDate,'2026-09-10','daily reporting follows local operation date');
assert.equal(result.events.rows.some(event=>event.taskId==='c'),false,'module event export excludes other mode');
assert.equal(result.packages.rows.some(row=>row.packageId==='p2'),false);
assert.equal(result.packages.rows.find(row=>row.packageId==='p1').totalTIDs,2);
assert.equal(result.packages.rows.find(row=>row.packageId==='p1').claimedTIDs,2);
assert.deepEqual(JSON.parse(result.packages.rows.find(row=>row.packageId==='p1').originalTIDsJSON),['000001','000002']);
assert.deepEqual(JSON.parse(result.packages.rows.find(row=>row.packageId==='p1').currentTIDsJSON),['000009','000002']);
const mixed = result.packages.rows.find(row=>row.packageId==='mixed');
assert.equal(mixed.totalTIDs,1);
assert.deepEqual(JSON.parse(mixed.rawBatchJSON).taskIds,['a']);
assert.deepEqual(JSON.parse(mixed.rawBatchJSON).tids,['000001']);
assert.equal(JSON.stringify(result).includes('900001'),false,'no cross-mode TID leakage in any report');
assert.equal(JSON.stringify(result).includes('多镜头保密影片'),false);

const movie = result.movies.rows.find(row=>row.movie==='修正影片');
assert.equal(movie.totalTIDs,2,'movie progress aggregates same film across all groups and allocation dates');
assert.equal(movie.groupCount,2);
assert.equal(movie.status_accepted,1);
assert.equal(movie.status_rejected,1);
assert.equal(movie.completionRate,'50.0%');
for (const row of [...result.movies.rows,...result.groups.rows]) {
  const total = Object.entries(row).filter(([key])=>key.startsWith('status_')).reduce((sum,[key,value])=>sum+value,0);
  assert.equal(total,row.totalTIDs,'actual status counts are disjoint and sum to all TIDs');
}
assert.equal(result.groups.rows.find(row=>row.groupId==='g1').movieCount,2);
const day = result.daily.rows.find(row=>row.date==='2026-09-10'&&row.groupId==='g1');
assert.equal(day.importedTIDs,1,'missing dispatch falls back to actual allocation timestamp');
assert.equal(day.initialAnnotationTIDs,1);
assert.equal(day.annotationReworkActions,1);
assert.equal(day.qcPassActions,2,'review actions count actual repeated events');
assert.equal(day.qcFailActions,1);
assert.equal(day.completedTIDs,1);
assert.equal(day.acceptanceFailActions,1);
assert.equal(day.qcSelfRepairActions,1);
assert.equal(day.qcPackageCount,2,'packs counted once per group from batches, not once per TID event');
assert.equal(day.acceptancePackageCount,1);
assert.equal(result.daily.rows.filter(row=>row.groupId==='g1').reduce((sum,row)=>sum+row.completedTIDs,0),1,'repeated acceptance pass never inflates first completed TIDs');
assert.equal(result.daily.rows.filter(row=>row.groupId==='g2').reduce((sum,row)=>sum+row.rejectedTIDs,0),1);
const csv = IO.csv(result.tasks.columns,result.tasks.rows);
assert.equal(IO.parseTable(csv).rows[0][result.tasks.columns.findIndex(column=>column.key==='rejectionReason')],'带,逗号\n多行说明');
const empty = Reports.build({...input,tasks:[]});
assert.ok(Object.values(empty).every(report=>report.rows.length===0),'empty mode yields no records from global state');

// Group/day settings are not task events, and distinct IDs separate identically
// named single/multi groups. Auto headcounts count work, never logins or QC work.
const groups = Array.from({length:14},(_,index)=>({id:`g${index+1}`,name:`${index%7+1}组`,defaultMode:index<7?'single':'multi',leader:index===0?'默认负责人':''}));
const staffingTasks = [
  {id:'staff-a',tid:'00001',movie:'影片',date:'2026-09-08',createdAt:'2026-09-08T02:00:00Z',groupId:'g1',mode:'single',status:'pending_qc'},
  {id:'staff-b',tid:'00002',movie:'影片',date:'2026-09-08',createdAt:'2026-09-08T02:00:00Z',groupId:'g1',mode:'single',status:'rework'},
  {id:'staff-m',tid:'80001',movie:'多镜影片',date:'2026-09-08',createdAt:'2026-09-08T02:00:00Z',groupId:'g8',mode:'multi',status:'pending_qc'}
];
const staffingEvents = [
  ev('staff-a','claim','2026-09-08T02:00:00Z',{actor:'旧成员01A'}),
  ev('staff-b','submit','2026-09-08T02:01:00Z',{actor:'张明',previousAssignee:'旧成员01A',actorRole:'annotation',submissionKind:'initial'}),
  ev('staff-a','submit','2026-09-08T02:02:00Z',{actor:'张明',actorRole:'annotation',submissionKind:'initial'}),
  ev('staff-a','login','2026-09-08T02:03:00Z',{actor:'只登录用户',actorRole:'annotation'}),
  ev('staff-a','claim','2026-09-08T02:04:00Z',{actor:'质检误操作',actorRole:'qc'}),
  ev('staff-a','qc_pass','2026-09-08T02:05:00Z',{actor:'质检员',actorRole:'qc'}),
  ev('staff-a','submit','2026-09-08T17:00:00Z',{actor:'张明',actorRole:'annotation',submissionKind:'rework'}),
  ev('staff-b','annotator_reject','2026-09-08T17:01:00Z',{actor:'李明',actorRole:'annotation'}),
  ev('staff-m','claim','2026-09-08T17:02:00Z',{actor:'多镜标注',actorRole:'annotation'})
];
function setting(id,groupId,mode,date,at,after) {
  return {id,type:'group_daily_edit',taskId:`group:${groupId}`,groupId,mode,date,at,actor:'组长',actorRole:'qc',before:{leader:'',total:0,headcount:null},after,note:'保留修改\n完整历史'};
}
const edits = [
  setting('set-day8','g1','single','2026-09-08','2026-09-08T04:00:00Z',{leader:'王组长',total:100,headcount:1.5}),
  setting('set-day9-first','g1','single','2026-09-09','2026-09-09T04:00:00Z',{leader:'陈组长',total:120,headcount:0.5}),
  setting('set-day9-reset','g1','single','2026-09-09','2026-09-09T05:00:00Z',{leader:'陈组长',total:150,headcount:null}),
  // A later edit of an older business day must not override a newer day's leader.
  setting('set-day8-late','g1','single','2026-09-08','2026-09-10T05:00:00Z',{leader:'历史负责人',total:101,headcount:1.5}),
  setting('set-empty','g7','single','2026-09-09','2026-09-09T06:00:00Z',{leader:'空组负责人',total:0,headcount:0}),
  setting('set-multi','g8','multi','2026-09-09','2026-09-09T06:00:00Z',{leader:'多镜负责人',total:999,headcount:8.5}),
  setting('set-wrong-mode','g1','multi','2026-09-09','2026-09-09T07:00:00Z',{leader:'错误模块',total:888,headcount:9})
];
const staffInput = {state:{tasks:staffingTasks,events:[...staffingEvents,...edits],batches:[]},tasks:staffingTasks,groups,mode:'single',localDate:input.localDate};
const staffBefore = JSON.stringify(staffInput);
const daily8 = Reports.groupDaily({...staffInput,date:'2026-09-08'});
assert.equal(daily8.length,7,'all module groups appear, including ones without tasks');
const g1day8 = daily8.find(row=>row.groupId==='g1');
assert.equal(g1day8.autoHeadcount,1,'legacy and continued Chinese identity count as the same worker');
assert.deepEqual(g1day8.members,['张明']);
assert.equal(g1day8.headcount,1.5,'half-person manual override is retained exactly');
assert.equal(g1day8.total,101,'latest edit of the same business day wins');
assert.equal(g1day8.leader,'历史负责人');
assert.equal(g1day8.latestEditId,'set-day8-late');
assert.equal(g1day8.history.length,2);
assert.equal(g1day8.headcountSource,'manual');
assert.equal(g1day8.isAggregate,false);
const day9 = Reports.groupDaily({...staffInput,date:'2026-09-09'});
const g1day9 = day9.find(row=>row.groupId==='g1');
assert.equal(g1day9.autoHeadcount,2,'UTC previous-day evening is actual next local date');
assert.equal(g1day9.headcount,2,'null override restores automatic headcount');
assert.equal(g1day9.headcountSource,'auto');
assert.equal(g1day9.total,150);
assert.equal(g1day9.leader,'陈组长','an edit of an older date must not override later-date leader');
assert.equal(g1day9.history.length,2);
const emptyGroup = day9.find(row=>row.groupId==='g7');
assert.equal(emptyGroup.total,0,'manual zero is distinct from never-entered null');
assert.equal(emptyGroup.headcount,0);
assert.equal(emptyGroup.headcountSource,'manual');
assert.equal(emptyGroup.autoHeadcount,0);
assert.equal(day9.find(row=>row.groupId==='g2').total,null);
assert.equal(day9.find(row=>row.groupId==='g2').leader,'待填写');
const day10 = Reports.groupDaily({...staffInput,date:'2026-09-10'}).find(row=>row.groupId==='g1');
assert.equal(day10.leader,'陈组长','leader carries forward to days without an edit');
assert.equal(day10.total,null,'daily total never carries forward');
assert.equal(day10.headcount,0,'daily staffing never carries forward');
assert.equal(day10.latestEditId,'','revision is for the requested day, not inherited leader');
assert.equal(Reports.groupDaily({...staffInput,date:'2026-09-07'})[0].leader,'默认负责人','future settings cannot leak backward');
const cumulative = Reports.groupDaily({...staffInput,date:''}).find(row=>row.groupId==='g1');
assert.equal(cumulative.total,251,'sum each recorded day once, not each edit');
assert.equal(cumulative.autoHeadcount,3,'cumulative staffing is person-days');
assert.equal(cumulative.headcount,3.5,'cumulative uses each day effective override or auto count');
assert.equal(cumulative.headcountSource,'manual');
assert.equal(cumulative.isAggregate,true);
assert.equal(cumulative.leader,'陈组长');
assert.equal(cumulative.history.length,4);
const multiStaff = Reports.groupDaily({...staffInput,mode:'multi',date:'2026-09-09'}).find(row=>row.groupId==='g8');
assert.equal(multiStaff.leader,'多镜负责人');
assert.equal(multiStaff.autoHeadcount,1);
assert.equal(multiStaff.headcount,8.5);
assert.equal(multiStaff.total,999);

const staffReport = Reports.build({...staffInput,statusMeta:input.statusMeta,groupLabel:id=>groups.find(group=>group.id===id)?.name});
assert.equal(staffReport.groups.rows.length,7);
assert.equal(staffReport.tasks.rows.length,2,'build also applies explicit mode to supplied tasks');
assert.equal(staffReport.events.rows.filter(row=>row.type==='group_daily_edit').length,5);
assert.ok(staffReport.events.rows.filter(row=>row.type==='group_daily_edit').every(row=>row.currentTid===''&&row.atTimeTid===''));
assert.equal(staffReport.events.rows.find(row=>row.eventId==='set-day8-late').settingDate,'2026-09-08');
assert.equal(staffReport.events.rows.find(row=>row.eventId==='set-day8-late').localDate,'2026-09-10');
assert.equal(staffReport.events.rows.some(row=>row.eventId==='set-multi'||row.eventId==='set-wrong-mode'),false);
const emptyDaily = staffReport.daily.rows.find(row=>row.groupId==='g7'&&row.date==='2026-09-09');
assert.ok(emptyDaily,'configuration-only group/date still exports a daily row');
assert.equal(emptyDaily.importedTIDs,0);
assert.equal(emptyDaily.completedTIDs,0);
assert.equal(emptyDaily.activeTIDs,0,'settings are not fake task activity');
assert.equal(emptyDaily.leader,'空组负责人');
assert.equal(JSON.parse(emptyDaily.settingsHistoryJSON).length,1);
const exportedG1 = staffReport.groups.rows.find(row=>row.groupId==='g1');
assert.equal(exportedG1.totalTIDs,2,'manual daily total never replaces actual task count');
assert.equal(exportedG1.total,251);
assert.equal(exportedG1.headcount,3.5);
assert.equal(JSON.parse(exportedG1.settingsHistoryJSON).length,4);
for(const report of [staffReport.groups,staffReport.daily,staffReport.events]) for(const row of report.rows) assert.ok(report.columns.every(column=>Object.hasOwn(row,column.key)));
assert.equal(JSON.stringify(staffInput),staffBefore,'new settings projections and exports never mutate input');
// Inclusive ranges use business dates for settings and local dates for work.
const inclusive = Reports.groupDaily({...staffInput,dateFrom:'2026-09-08',dateTo:'2026-09-09'});
const inclusiveG1 = inclusive.find(row=>row.groupId==='g1');
assert.equal(inclusive.length,7,'date ranges retain groups without matching records');
assert.equal(inclusiveG1.date,'');
assert.equal(inclusiveG1.isAggregate,true);
assert.equal(inclusiveG1.total,251,'both end dates contribute their latest manual daily total once');
assert.equal(inclusiveG1.headcount,3.5);
assert.equal(inclusiveG1.autoHeadcount,3,'auto headcount counts person-days');
assert.deepEqual(new Set(inclusiveG1.members),new Set(['张明','李明']),'members stay unique across days');
assert.equal(inclusiveG1.headcountSource,'manual');
assert.equal(inclusiveG1.leader,'陈组长');
assert.equal(inclusiveG1.latestEditId,'set-day9-reset','aggregate revision follows business day, not write timestamp');
assert.equal(inclusiveG1.history.length,4);
assert.deepEqual(Reports.groupDaily({...staffInput,dateFrom:'2026-09-09',dateTo:'2026-09-09'}),day9,'same-day bounds exactly preserve legacy daily rows and revision semantics');
assert.deepEqual(Reports.groupDaily({...staffInput,dateFrom:'2026-09-10',dateTo:'2026-09-10'}).find(row=>row.groupId==='g1'),day10,'empty single day inherits leader without inheriting revision');
assert.deepEqual(Reports.groupDaily({...staffInput,date:'2026-09-09',dateFrom:'',dateTo:''}),Reports.groupDaily({...staffInput,date:''}),'explicit empty range overrides stale legacy date and means all dates');
assert.deepEqual(Reports.groupDaily({...staffInput,dateFrom:null,dateTo:undefined}),Reports.groupDaily({...staffInput,date:''}));

const through8 = Reports.groupDaily({...staffInput,dateTo:'2026-09-08'}).find(row=>row.groupId==='g1');
assert.equal(through8.isAggregate,true,'an open boundary remains aggregate even with one active day');
assert.equal(through8.total,101);
assert.equal(through8.headcount,1.5);
assert.equal(through8.autoHeadcount,1);
assert.equal(through8.leader,'历史负责人','future business-day leaders cannot leak through a bounded end');
assert.equal(through8.latestEditId,'set-day8-late');
assert.deepEqual(new Set(through8.history.map(event=>event.id)),new Set(['set-day8','set-day8-late']),'late writes stay with their selected business date');
const from9 = Reports.groupDaily({...staffInput,dateFrom:'2026-09-09'}).find(row=>row.groupId==='g1');
assert.equal(from9.total,150);
assert.equal(from9.headcount,2,'null reset uses actual local-day automatic attendance');
assert.equal(from9.autoHeadcount,2);
assert.equal(from9.headcountSource,'auto','excluded overrides cannot change range attendance source');
assert.equal(from9.history.length,2);
assert.ok(from9.history.every(event=>event.date==='2026-09-09'));
assert.equal(from9.leader,'陈组长');
assert.equal(inclusive.find(row=>row.groupId==='g7').total,0,'manual zero is distinct from no entered total');
assert.equal(inclusive.find(row=>row.groupId==='g2').total,null);

const withoutActivity = Reports.groupDaily({...staffInput,dateFrom:'2026-09-10',dateTo:'2026-09-12'}).find(row=>row.groupId==='g1');
assert.equal(withoutActivity.leader,'陈组长','responsible person can carry from before the range');
assert.equal(withoutActivity.total,null,'daily total never carries into an empty range');
assert.equal(withoutActivity.autoHeadcount,0);
assert.equal(withoutActivity.headcount,0);
assert.deepEqual(withoutActivity.members,[]);
assert.deepEqual(withoutActivity.history,[],'leader inheritance does not leak older settings into range history');
assert.equal(withoutActivity.latestEditId,'');
assert.equal(withoutActivity.isAggregate,true);
const beforeSettings = Reports.groupDaily({...staffInput,dateTo:'2026-09-07'}).find(row=>row.groupId==='g1');
assert.equal(beforeSettings.leader,'默认负责人');
assert.equal(beforeSettings.total,null);
assert.deepEqual(beforeSettings.history,[]);
const rangeMulti = Reports.groupDaily({...staffInput,mode:'multi',dateFrom:'2026-09-08',dateTo:'2026-09-09'});
assert.equal(rangeMulti.some(row=>row.groupId==='g1'),false);
assert.equal(rangeMulti.find(row=>row.groupId==='g8').total,999);
assert.equal(rangeMulti.find(row=>row.groupId==='g8').autoHeadcount,1);
assert.equal(rangeMulti.find(row=>row.groupId==='g8').headcount,8.5);

const laterEdit = setting('set-day11','g1','single','2026-09-11','2026-09-11T04:00:00Z',{leader:'后任负责人',total:400,headcount:0.5});
const futureInput = {...staffInput,state:{...staffInput.state,events:[...staffInput.state.events,laterEdit]}};
assert.equal(Reports.groupDaily({...futureInput,dateFrom:'2026-09-10',dateTo:'2026-09-10'}).find(row=>row.groupId==='g1').leader,'陈组长');
const from10 = Reports.groupDaily({...futureInput,dateFrom:'2026-09-10'}).find(row=>row.groupId==='g1');
assert.equal(from10.leader,'后任负责人');
assert.equal(from10.total,400);
assert.deepEqual(from10.history.map(event=>event.id),['set-day11']);
assert.equal(from10.latestEditId,'set-day11');
assert.deepEqual(Reports.build({...staffInput,statusMeta:input.statusMeta,groupLabel:id=>groups.find(group=>group.id===id)?.name,dateFrom:'2026-09-09',dateTo:'2026-09-09'}),staffReport,'exports stay complete even when given a UI range');
assert.throws(()=>Reports.groupDaily({...staffInput,dateFrom:'2026-09-10',dateTo:'2026-09-09'}),RangeError,'reversed bounds must not silently produce empty totals');
for(const invalid of ['2026-02-29','1900-02-29','2026-04-31','2026-13-01','2026-00-01','2026-09-00','0000-01-01','09/09/2026','2026-9-9']) {
  assert.throws(()=>Reports.groupDaily({...staffInput,dateFrom:invalid}),RangeError,`invalid lower date: ${invalid}`);
  assert.throws(()=>Reports.groupDaily({...staffInput,dateTo:invalid}),RangeError,`invalid upper date: ${invalid}`);
}
assert.doesNotThrow(()=>Reports.groupDaily({...staffInput,dateFrom:'2000-02-29',dateTo:'2024-02-29'}),'Gregorian leap years remain valid');
assert.deepEqual(Reports.groupDaily({...staffInput,dateFrom:' 2026-09-09 ',dateTo:'2026-09-09'}),day9);
inclusiveG1.history[0].after.total=54321;
assert.equal(JSON.stringify(staffInput),staffBefore,'range histories are detached and source data stays immutable');

// QC ownership is derived from actual ordered task actions, never the group's
// registered responsible person, annotation assignee, or last arbitrary actor.
const noOperator = {name:'',at:'',type:''};
assert.deepEqual(Reports.qcOperator([]),noOperator);
assert.deepEqual(Reports.qcOperator(),noOperator);
const originalQc = {type:'qc_fail',actor:'首检人员',actorRole:'qc',at:'2026-09-10T09:00:00Z'};
const latestQc = {type:'qc_pass',actor:'复检人员',actorRole:'qc',at:'2026-09-09T09:00:00Z'};
assert.deepEqual(Reports.qcOperator([originalQc,latestQc]),{name:'复检人员',at:latestQc.at,type:'qc_pass'},'stable event order takes precedence over timestamp sorting');
assert.deepEqual(Reports.qcOperator([{type:'qc_pass',actor:' 成员01A ',at:'legacy-time'}]),{name:' 成员01A ',at:'legacy-time',type:'qc_pass'},'legacy names stay exact and are never automatically replaced');
for(const type of ['qc_pass','qc_fail','reject_confirm','reject_return','acceptance_route','qc_repair_done','sent_acceptance']) {
  const action = {type,actor:'本次质检',actorRole:'qc',at:'2026-09-10T10:00:00Z'};
  assert.equal(Reports.qcOperator([originalQc,action]).name,'本次质检',`valid QC action: ${type}`);
  const legacy = {...action};delete legacy.actorRole;
  assert.equal(Reports.qcOperator([legacy]).name,'本次质检',`untyped legacy QC action: ${type}`);
  for(const role of ['admin','acceptance','annotation','',null]) assert.equal(Reports.qcOperator([originalQc,{...action,actorRole:role}]).name,'首检人员',`explicit non-QC role excluded: ${type}/${role}`);
}
for(const type of ['package_built','package_claimed']) {
  for(const stage of ['qc','acceptance']) {
    const action = {type,stage,actor:'建包领取人',actorRole:'qc',at:'2026-09-10T11:00:00Z'};
    assert.deepEqual(Reports.qcOperator([action]),{name:'建包领取人',at:action.at,type},'package action identifies operator before any audit result');
    const legacy = {...action};delete legacy.actorRole;
    assert.equal(Reports.qcOperator([legacy]).name,'建包领取人');
    assert.deepEqual(Reports.qcOperator([{...action,actorRole:'acceptance'}]),noOperator);
    assert.deepEqual(Reports.qcOperator([{...action,actorRole:'admin'}]),noOperator);
  }
  for(const stage of ['',undefined,'annotation']) assert.deepEqual(Reports.qcOperator([{type,stage,actor:'错误阶段',actorRole:'qc'}]),noOperator);
}
const excludedTypes = ['dispatch','metadata_edit','group_daily_edit','claim','submit','annotator_reject','acceptance_pass','acceptance_fail'];
for(const type of excludedTypes) assert.equal(Reports.qcOperator([originalQc,{type,actor:'后续操作人',actorRole:'qc'}]).name,'首检人员',`unrelated action never overwrites QC operator: ${type}`);
assert.deepEqual(Reports.qcOperator([originalQc,{type:'qc_pass',actor:' \n\t',actorRole:'qc'},{type:'reject_confirm',actorRole:'qc'}]),{name:originalQc.actor,at:originalQc.at,type:originalQc.type},'later unnamed actions fall back to the last named valid operator');
const frozenHistory = Object.freeze([Object.freeze({...originalQc}),Object.freeze({...latestQc})]);
const frozenBefore = JSON.stringify(frozenHistory);
const detachedOperator = Reports.qcOperator(frozenHistory);detachedOperator.name='修改返回值';
assert.equal(JSON.stringify(frozenHistory),frozenBefore);

const operatorTasks = [
  {id:'op-single',tid:'001',movie:'同名影片',mode:'single',groupId:'g1',date:'2026-09-10',status:'pending_acceptance'},
  {id:'op-multi',tid:'002',movie:'同名影片',mode:'multi',groupId:'g8',date:'2026-09-10',status:'pending_qc'},
  {id:'op-empty',tid:'003',movie:'无质检影片',mode:'single',groupId:'g1',date:'2026-09-10',status:'unclaimed'}
];
const operatorEvents = [
  ev('op-single','qc_fail','2026-09-10T01:00:00Z',{actor:'最初质检',actorRole:'qc',pLevel:'P1',tags:['补标缺失'],note:'原始首检'}),
  ev('op-single','qc_pass','2026-09-10T02:00:00Z',{actor:'复检质检',actorRole:'qc'}),
  ev('op-single','reject_return','2026-09-10T03:00:00Z',{actor:'拒绝审核员',actorRole:'qc'}),
  ev('op-single','package_claimed','2026-09-10T04:00:00Z',{actor:'送验领包人',actorRole:'qc',stage:'acceptance'}),
  ev('op-single','acceptance_fail','2026-09-10T05:00:00Z',{actor:'后续验收员',actorRole:'acceptance'}),
  ev('op-single','metadata_edit','2026-09-10T06:00:00Z',{actor:'admin',actorRole:'admin'}),
  ev('op-multi','package_built','2026-09-10T04:00:00Z',{actor:'多镜质检',actorRole:'qc',stage:'qc'}),
  setting('op-setting','g1','single','2026-09-10','2026-09-10T07:00:00Z',{leader:'登记负责人',total:300,headcount:null})
];
const operatorInput = {state:{tasks:operatorTasks,events:operatorEvents,batches:[]},tasks:operatorTasks,groups,mode:'single',statusMeta:{}};
const operatorBefore = JSON.stringify(operatorInput);
const operatorReport = Reports.build(operatorInput);
const operatorRow = operatorReport.tasks.rows.find(row=>row.taskId==='op-single');
assert.equal(operatorRow.qcOperator,'送验领包人');
assert.equal(operatorRow.qcOperatorAt,'2026-09-10T04:00:00Z');
assert.equal(operatorRow.firstQcActor,'最初质检');
assert.equal(operatorRow.firstQcPLevel,'P1');
assert.equal(operatorRow.firstQcNote,'原始首检');
assert.equal(operatorRow.latestQcActor,'复检质检','latest audit columns are separate from latest QC workflow actor');
assert.equal(JSON.parse(operatorRow.fullTimelineJSON).length,operatorEvents.filter(event=>event.taskId==='op-single').length);
assert.equal(operatorReport.tasks.rows.find(row=>row.taskId==='op-empty').qcOperator,'');
assert.equal(operatorReport.tasks.rows.find(row=>row.taskId==='op-empty').qcOperatorAt,'');
assert.equal(operatorReport.tasks.rows.some(row=>row.taskId==='op-multi'),false);
assert.equal(Reports.build({...operatorInput,mode:'multi'}).tasks.rows[0].qcOperator,'多镜质检');
assert.equal(operatorReport.tasks.columns.find(column=>column.key==='qcOperator').label,'组长 / 质检操作人');
assert.equal(operatorReport.tasks.columns.find(column=>column.key==='qcOperatorAt').label,'最近质检操作时间');
const operatorCsv = IO.parseTable(IO.csv(operatorReport.tasks.columns,operatorReport.tasks.rows));
assert.equal(operatorCsv.rows[0][operatorCsv.headers.indexOf('组长 / 质检操作人')],'送验领包人');
assert.equal(JSON.stringify(operatorInput),operatorBefore,'operator projection and CSV preparation never change input records');

// Whole-film progress normalizes only generated seed suffixes. Real imported
// dates, sequels and corrected names remain separate, in every export as well.
const seedTitles = ['星河远征','风起长安','云海纪事','逐光计划','城南旧影','深蓝航线','奇境档案','森林来信','月面旅人','时光拼图'];
seedTitles.forEach((title,index)=> {
  const groupId = `g${String(index+1).padStart(2,'0')}`;
  assert.equal(Reports.movieTitle({id:`seed_task_20260909_${groupId}_1`,movie:`${title} · 09-09`}),title);
  assert.equal(Reports.movieTitle({id:`seed_task_20261231_${groupId}_8`,movie:`${title} · 12-31`}),title);
});
const titleGuards = [
  {id:'import_task_1',movie:'城南旧影 · 09-09'},
  {id:'seed_task_20260909_g05_1_copy',movie:'城南旧影 · 09-09'},
  {id:'seed_task_20260909_g05_9',movie:'城南旧影 · 09-09'},
  {id:'seed_task_20260909_g05_01',movie:'城南旧影 · 09-09'},
  {id:'seed_task_20260909_g11_1',movie:'城南旧影 · 09-09'},
  {id:'seed_task_20260909_g00_1',movie:'城南旧影 · 09-09'},
  {id:'seed_task_20260909_g01_1',movie:'城南旧影 · 09-09'},
  {id:'seed_task_20260909_g05_1',movie:'城南旧影 · 09-10'},
  {id:'seed_task_20260909_g05_1',movie:'城南旧影·09-09'},
  {id:'seed_task_20260909_g05_1',movie:'城南旧影 · 09-09 '},
  {id:'seed_task_20260909_g05_1',movie:'城南旧影第二部 · 09-09'},
  {id:'seed_task_20260909_g05_1',movie:'改名影片 · 09-09'},
  {id:'seed_task_20260229_g05_1',movie:'城南旧影 · 02-29'}
];
for(const task of titleGuards) assert.equal(Reports.movieTitle(task),task.movie,`keep exact non-original suffix: ${task.id}/${task.movie}`);
assert.equal(Reports.movieTitle({movie:'城南旧影'}),'城南旧影');
assert.equal(Reports.movieTitle(), '');

const wholeFilmTasks = [
  {id:'seed_task_20260909_g05_1',tid:'000001',movie:'城南旧影 · 09-09',date:'2026-09-09',groupId:'g05',mode:'single',status:'accepted'},
  {id:'seed_task_20260910_g05_2',tid:'000002',movie:'城南旧影 · 09-10',date:'2026-09-10',groupId:'g05',mode:'single',status:'rejected'},
  {id:'film-import-open',tid:'000003',movie:'城南旧影',date:'2026-09-11',groupId:'g01',mode:'single',status:'annotation_done'},
  {id:'film-import-dated',tid:'000004',movie:'城南旧影 · 09-09',date:'2026-09-11',groupId:'g01',mode:'single',status:'accepted'},
  {id:'seed_task_20260909_g05_3',tid:'000005',movie:'城南旧影第二部',date:'2026-09-09',groupId:'g05',mode:'single',status:'unclaimed'},
  {id:'film-multi',tid:'000006',movie:'城南旧影',date:'2026-09-11',groupId:'g06',mode:'multi',status:'rejected'},
  {id:'film-refused-a',tid:'000007',movie:'全部拒绝的影片',date:'2026-09-09',groupId:'g01',mode:'single',status:'rejected'},
  {id:'film-refused-b',tid:'000008',movie:'全部拒绝的影片',date:'2026-09-10',groupId:'g05',mode:'single',status:'rejected'}
];
const filmMeta = {accepted:{label:'验收通过'},rejected:{label:'确认拒绝'},rejection_pending:{label:'拒绝待确认'},unclaimed:{label:'待标注'},annotation_done:{label:'待建质检包'}};
const wholeFilmInput = {tasks:wholeFilmTasks,mode:'single',groupLabel:id=>({g01:'1组',g05:'5组',g06:'1组'})[id],statusMeta:filmMeta};
const wholeFilmBefore = JSON.stringify(wholeFilmInput);
const allFilms = Reports.movieProgress(wholeFilmInput);
const wholeFilm = allFilms.find(row=>row.movie==='城南旧影');
assert.equal(wholeFilm.key,JSON.stringify(['single','城南旧影']));
assert.equal(wholeFilm.mode,'single');
assert.equal(wholeFilm.total,3,'original dates and an undated import combine across dates and groups');
assert.equal(wholeFilm.accepted,1);
assert.equal(wholeFilm.rejected,1);
assert.equal(wholeFilm.active,1);
assert.equal(wholeFilm.closed,false);
assert.equal(wholeFilm.closureRate,2/3*100);
assert.equal(wholeFilm.completionRate,1/3*100,'main completion remains acceptance passes divided by total');
assert.deepEqual(wholeFilm.groupIds,['g05','g01']);
assert.deepEqual(wholeFilm.groups,['5组','1组']);
assert.deepEqual(wholeFilm.sourceNames,['城南旧影 · 09-09','城南旧影 · 09-10','城南旧影']);
assert.deepEqual(wholeFilm.taskIds,wholeFilmTasks.slice(0,3).map(task=>task.id));
assert.equal(wholeFilm.statusCounts.rejection_pending,0);
assert.equal(Object.values(wholeFilm.statusCounts).reduce((a,b)=>a+b,0),3);
assert.deepEqual(Reports.movieProgress({...wholeFilmInput,groupId:'g05'}).find(row=>row.movie==='城南旧影'),wholeFilm,'group participation filtering never changes whole-film counts or closure');
assert.deepEqual(Reports.movieProgress({...wholeFilmInput,groupId:'g01'}).find(row=>row.movie==='城南旧影'),wholeFilm);
assert.equal(Reports.movieProgress({...wholeFilmInput,groupId:'g05'}).some(row=>row.movie==='城南旧影 · 09-09'),false,'a real dated import is a distinct film that this group does not participate in');
assert.deepEqual(Reports.movieProgress({...wholeFilmInput,groupId:'all'}),allFilms);
assert.deepEqual(Reports.movieProgress({...wholeFilmInput,groupId:'missing'}),[]);
assert.deepEqual(Reports.movieProgress({tasks:[],statusMeta:filmMeta}),[]);
assert.deepEqual(Reports.movieProgress(),[]);
const rejectedFilm = allFilms.find(row=>row.movie==='全部拒绝的影片');
assert.equal(rejectedFilm.closed,true,'a film with all confirmed refusals is closed');
assert.equal(rejectedFilm.completionRate,0,'all-refused closure never becomes a 100% acceptance rate');
assert.equal(rejectedFilm.closureRate,100);
assert.equal(rejectedFilm.active,0);
const reopened = Reports.movieProgress({...wholeFilmInput,tasks:[...wholeFilmTasks,{id:'new-film-tid',tid:'000009',movie:'全部拒绝的影片',groupId:'g01',mode:'single',status:'unclaimed'}]}).find(row=>row.movie==='全部拒绝的影片');
assert.equal(reopened.closed,false,'adding an incomplete TID immediately reopens the film');
assert.equal(reopened.total,3);
assert.equal(reopened.active,1);
for(const status of ['rejection_pending','legacy_unknown','__proto__',undefined]) {
  const pending = Reports.movieProgress({tasks:[{id:'pending',movie:'影片',mode:'single',status}],statusMeta:filmMeta})[0];
  assert.equal(pending.active,1,`nonterminal status stays active: ${status}`);
  assert.equal(pending.closed,false);
  assert.equal(pending.closureRate,0);
  assert.equal(Object.values(pending.statusCounts).reduce((a,b)=>a+b,0),1,'unknown status counts are not lost');
}
const splitModes = Reports.movieProgress({...wholeFilmInput,mode:''}).filter(row=>row.movie==='城南旧影');
assert.equal(splitModes.length,2,'same film names in single and multi never share a summary row');
assert.equal(splitModes.find(row=>row.mode==='single').total,3);
assert.equal(splitModes.find(row=>row.mode==='multi').total,1);
assert.notEqual(splitModes[0].key,splitModes[1].key);
assert.equal(Reports.movieProgress({...wholeFilmInput,mode:'multi'})[0].closed,true);
assert.equal(allFilms.find(row=>row.movie==='城南旧影第二部').total,1,'renamed seed leaves its old whole-film aggregate');
assert.equal(JSON.stringify(wholeFilmInput),wholeFilmBefore);
wholeFilm.groupIds.push('not-real');wholeFilm.taskIds.push('not-real');wholeFilm.sourceNames.push('not-real');wholeFilm.statusCounts.accepted=999;
assert.equal(JSON.stringify(wholeFilmInput),wholeFilmBefore,'returned arrays and counters are detached from tasks');

const filmRawTasks = wholeFilmTasks.map(task=>({...task,movie:task.id==='seed_task_20260909_g05_3'?'城南旧影 · 09-09':task.movie}));
const filmEvents = filmRawTasks.map(task=>ev(task.id,'dispatch',`${task.date}T03:00:00Z`,{movieAtEvent:task.movie,tidAtEvent:task.tid}));
filmEvents.push(ev('seed_task_20260909_g05_3','metadata_edit','2026-09-10T03:00:00Z',{before:{movie:'城南旧影 · 09-09'},after:{movie:'城南旧影第二部'},note:'改名,说明\n历史保留'}));
const filmState = {tasks:filmRawTasks,events:filmEvents,batches:[{id:'film-import-batch',kind:'import',taskIds:filmRawTasks.map(task=>task.id),movies:filmRawTasks.map(task=>task.movie)}],extra:{retained:'备份原样'}};
const filmStateBefore = JSON.stringify(filmState);
const filmReport = Reports.build({...wholeFilmInput,state:filmState});
const exportFilm = filmReport.movies.rows.find(row=>row.movie==='城南旧影');
assert.equal(exportFilm.totalTIDs,3);
assert.equal(exportFilm.taskCount,3);
assert.equal(exportFilm.mode,'单镜头');
assert.equal(exportFilm.modeCode,'single');
assert.equal(exportFilm.movieCount,1,'summary film count uses normalized whole-film identity');
assert.equal(exportFilm.sourceNameCount,3,'the original raw-name count remains separately available');
assert.equal(exportFilm.groupCount,2);
assert.equal(exportFilm.closed,false);
assert.equal(exportFilm.closureStatus,'流程中');
assert.equal(exportFilm.closedTIDs,2);
assert.equal(exportFilm.activeTIDs,1);
assert.equal(exportFilm.rejectedTIDs,1);
assert.equal(exportFilm.closureRate,'66.7%');
assert.equal(exportFilm.completionRate,'33.3%');
assert.equal(exportFilm.status_accepted,1);
assert.equal(exportFilm.status_rejected,1);
assert.equal(exportFilm.status_annotation_done,1);
assert.equal(exportFilm.firstAllocationDate,'2026-09-09');
assert.equal(exportFilm.lastAllocationDate,'2026-09-11');
assert.deepEqual(JSON.parse(exportFilm.moviesJSON),['城南旧影 · 09-09','城南旧影 · 09-10','城南旧影']);
assert.deepEqual(JSON.parse(exportFilm.sourceNamesJSON),JSON.parse(exportFilm.moviesJSON));
assert.deepEqual(JSON.parse(exportFilm.groupIdsJSON),['g05','g01']);
assert.deepEqual(JSON.parse(exportFilm.currentTIDsJSON),['000001','000002','000003']);
assert.equal(filmReport.movies.rows.find(row=>row.movie==='全部拒绝的影片').completionRate,'0.0%');
assert.equal(filmReport.movies.rows.find(row=>row.movie==='全部拒绝的影片').closureStatus,'已闭环');
assert.equal(filmReport.tasks.rows.find(row=>row.taskId===wholeFilmTasks[0].id).movie,'城南旧影 · 09-09');
assert.equal(filmReport.tasks.rows.find(row=>row.taskId===wholeFilmTasks[0].id).movieTitle,'城南旧影');
assert.equal(filmReport.tasks.rows.find(row=>row.taskId==='film-import-dated').movieTitle,'城南旧影 · 09-09');
assert.equal(filmReport.events.rows.find(row=>row.taskId===wholeFilmTasks[0].id).atTimeMovie,'城南旧影 · 09-09');
assert.equal(JSON.parse(filmReport.tasks.rows.find(row=>row.taskId==='seed_task_20260909_g05_3').originalTaskJSON).movie,'城南旧影 · 09-09');
assert.deepEqual(JSON.parse(filmReport.tasks.rows.find(row=>row.taskId==='seed_task_20260909_g05_3').fullTimelineJSON),filmEvents.filter(event=>event.taskId==='seed_task_20260909_g05_3'));
for(const report of Object.values(filmReport)) {
  assert.equal(new Set(report.columns.map(column=>column.key)).size,report.columns.length);
  for(const row of report.rows) assert.ok(report.columns.every(column=>Object.hasOwn(row,column.key)));
}
const filmCsv = IO.parseTable(IO.csv(filmReport.tasks.columns,filmReport.tasks.rows));
const filmColumn = key=>filmReport.tasks.columns.findIndex(column=>column.key===key);
assert.equal(filmCsv.rows[0][filmColumn('tid')],'000001');
assert.equal(filmCsv.rows[0][filmColumn('movie')],'城南旧影 · 09-09');
assert.equal(filmCsv.rows[0][filmColumn('movieTitle')],'城南旧影');
assert.deepEqual(JSON.parse(filmCsv.rows[0][filmColumn('originalTaskJSON')]),filmRawTasks[0]);
assert.deepEqual(JSON.parse(filmCsv.rows[0][filmColumn('fullTimelineJSON')]),filmEvents.filter(event=>event.taskId===filmRawTasks[0].id));
const filmsCsv = IO.parseTable(IO.csv(filmReport.movies.columns,filmReport.movies.rows));
assert.equal(filmsCsv.rows.length,filmReport.movies.rows.length);
assert.ok(filmsCsv.headers.includes('整片流程状态'));
assert.equal(Reports.build({...wholeFilmInput,state:filmState,mode:''}).movies.rows.filter(row=>row.movie==='城南旧影').length,2,'complete exports keep modules disjoint even without an explicit filter');
const twoDaySeedReport = Reports.build({...wholeFilmInput,tasks:wholeFilmTasks.slice(0,2),state:{tasks:filmRawTasks.slice(0,2),events:[],batches:[]}});
assert.equal(twoDaySeedReport.movies.rows.length,1);
assert.equal(twoDaySeedReport.movies.rows[0].movieCount,1,'two seed dates represent one whole film in film summaries');
assert.equal(twoDaySeedReport.movies.rows[0].sourceNameCount,2);
assert.equal(twoDaySeedReport.groups.rows[0].movieCount,1,'group film counts use the same whole-film identity across dates');
assert.deepEqual(JSON.parse(twoDaySeedReport.groups.rows[0].moviesJSON),['城南旧影 · 09-09','城南旧影 · 09-10'],'group exports retain both original package names');
const crossModeFilmRows = Reports.build({...wholeFilmInput,state:filmState,mode:''}).movies.rows.filter(row=>row.movie==='城南旧影');
assert.ok(crossModeFilmRows.every(row=>row.movieCount===1));
assert.deepEqual(new Set(crossModeFilmRows.map(row=>row.modeCode)),new Set(['single','multi']));
assert.equal(JSON.stringify(filmState),filmStateBefore,'raw task, event and import fields remain byte-for-byte identical for full backup');
assert.deepEqual(JSON.parse(JSON.stringify(filmState)),JSON.parse(filmStateBefore));

const originalSeeds = ['20260909','20260910'].flatMap(date=>seedTitles.flatMap((movie,index)=>Array.from({length:8},(_,i)=>({
  id:`seed_task_${date}_g${String(index+1).padStart(2,'0')}_${i+1}`,tid:`DEMO-${date}-${index+1}-${i+1}`,movie:`${movie} · ${date.slice(4,6)}-${date.slice(6,8)}`,
  mode:index<5?'single':'multi',groupId:`g${String(index+1).padStart(2,'0')}`,status:i===7?'accepted':'unclaimed'
}))));
const originalSeedsBefore = JSON.stringify(originalSeeds);
assert.equal(originalSeeds.length,160);
for(const mode of ['single','multi']) {
  const filmRows = Reports.movieProgress({tasks:originalSeeds,mode});
  assert.equal(filmRows.length,5);
  assert.ok(filmRows.every(row=>row.total===16&&row.sourceNames.length===2));
  assert.equal(filmRows.reduce((sum,row)=>sum+row.total,0),80);
}
assert.equal(JSON.stringify(originalSeeds),originalSeedsBefore,'all 160 original seed records are unchanged');

// Rework assignment is a real change of person, not an identity alias or an
// annotation claim. Credit follows each actual submission at its event time.
const transfer = (id,from,to,at,status='rework',details={}) => ev(id,'claim',at,{assignmentKind:'rework_transfer',workflowVersion:4,fromAssignee:from,assignee:to,assignmentStatus:status,groupId:'g1',mode:'single',actor:'分配组长',actorRole:'qc',note:'请假代修',...details});
const transferHistory = [
  ev('transfer-task','dispatch','2026-09-08T01:00:00Z'),
  ev('transfer-task','claim','2026-09-08T02:00:00Z',{actor:'张明',actorRole:'annotation',assignee:'张明'}),
  ev('transfer-task','submit','2026-09-08T03:00:00Z',{actor:'张明',actorRole:'annotation',submissionKind:'initial'}),
  ev('transfer-task','qc_fail','2026-09-08T04:00:00Z',{actor:'首检组长',actorRole:'qc',pLevel:'P1',tags:['补标缺失'],note:'首检原说明'}),
  transfer('transfer-task','张明','李明','2026-09-09T01:00:00Z'),
  ev('transfer-task','submit','2026-09-09T02:00:00Z',{actor:'李明',actorRole:'annotation',submissionKind:'rework',previousAssignee:'张明'}),
  ev('transfer-task','qc_pass','2026-09-09T03:00:00Z',{actor:'复检组长',actorRole:'qc',workflowVersion:3}),
  ev('transfer-task','acceptance_pass','2026-09-10T01:00:00Z',{actor:'验收人员',actorRole:'acceptance',workflowVersion:3}),
  ev('transfer-task','acceptance_fail','2026-09-10T02:00:00Z',{actor:'验收人员',actorRole:'acceptance',workflowVersion:3}),
  ev('transfer-task','acceptance_route','2026-09-10T03:00:00Z',{actor:'分流组长',actorRole:'qc',workflowVersion:3,route:'annotation'}),
  transfer('transfer-task','李明','王明','2026-09-11T01:00:00Z','acceptance_rework',{note:'请假代修,说明\n保留换行'}),
  ev('transfer-task','submit','2026-09-12T01:00:00Z',{actor:'王明',actorRole:'annotation',submissionKind:'rework'}),
  ev('transfer-task','qc_pass','2026-09-12T02:00:00Z',{actor:'后续质检',actorRole:'qc',workflowVersion:3}),
  ev('transfer-task','acceptance_pass','2026-09-12T03:00:00Z',{actor:'后续验收',actorRole:'acceptance',workflowVersion:3})
];
const transferBefore = JSON.stringify(transferHistory);
const contributions = Reports.annotationContributors(transferHistory);
assert.deepEqual(contributions.initial,{name:'张明',rawName:'张明',at:transferHistory[2].at,eventId:transferHistory[2].id});
assert.deepEqual(contributions.submissions.map(row=>[row.name,row.kind]),[['张明','initial'],['李明','rework'],['王明','rework']]);
assert.deepEqual(contributions.rework.map(row=>[row.name,row.count]),[['李明',1],['王明',1]]);
assert.equal(contributions.firstQc.name,'张明','the original annotation keeps its first QC result after real reassignment');
assert.equal(contributions.firstQc.type,'qc_fail');assert.equal(contributions.firstQc.pLevel,'P1');
assert.deepEqual(contributions.firstQc.tags,['补标缺失']);
assert.equal(contributions.firstQc.at,transferHistory[3].at);
assert.equal(contributions.firstAcceptance.name,'李明','first acceptance belongs to the actual submitter at that time, not a later owner');
assert.equal(contributions.firstAcceptance.at,transferHistory[7].at);
assert.equal(contributions.firstAcceptance.rawName,'李明');
assert.deepEqual(Reports.annotationContributors(),{initial:null,submissions:[],rework:[],firstQc:null,firstAcceptance:null});
assert.deepEqual(Reports.annotationContributors([transferHistory[4]]),Reports.annotationContributors(),'assignment alone is not annotation work or a first claim');
assert.deepEqual(Reports.qcOperator(transferHistory.slice(0,5)),{name:'分配组长',at:transferHistory[4].at,type:'claim'},'actual QC assignment is a named QC operation');
assert.equal(Reports.qcOperator([transferHistory[3],{...transferHistory[4],actorRole:'annotation'}]).name,'首检组长','malformed non-QC assignments never become a QC operator');
contributions.firstQc.tags.push('修改返回值');contributions.rework[0].events[0].rawName='修改返回值';
assert.equal(JSON.stringify(transferHistory),transferBefore);

const aliasHistory = [
  ev('alias-task','claim','2026-09-08T01:00:00Z',{actor:'旧成员01A',assignee:'旧成员01A'}),
  ev('alias-task','submit','2026-09-08T02:00:00Z',{actor:'旧成员01A',submissionKind:'initial'}),
  ev('alias-task','qc_fail','2026-09-08T03:00:00Z',{actor:'组长',actorRole:'qc',pLevel:'P2'}),
  ev('alias-task','submit','2026-09-08T04:00:00Z',{actor:'张明',actorRole:'annotation',previousAssignee:'旧成员01A',identityAlias:true,submissionKind:'rework'}),
  ev('alias-task','qc_fail','2026-09-08T05:00:00Z',{actor:'组长',actorRole:'qc',workflowVersion:3,pLevel:'P2'}),
  transfer('alias-task','张明','李明','2026-09-09T01:00:00Z'),
  ev('alias-task','submit','2026-09-09T02:00:00Z',{actor:'李明',actorRole:'annotation',submissionKind:'rework'})
];
const aliasContributions = Reports.annotationContributors(aliasHistory);
assert.equal(aliasContributions.initial.name,'张明','explicit identity continuation may unify display names');
assert.equal(aliasContributions.initial.rawName,'旧成员01A','original names remain independently traceable');
assert.equal(aliasContributions.firstQc.name,'张明');
assert.deepEqual(aliasContributions.rework.map(row=>[row.name,row.count]),[['张明',1],['李明',1]],'true later transfer does not merge with the continued identity');
const legacyAliasHistory = aliasHistory.map(event=>{const copy={...event};delete copy.identityAlias;return copy;});
assert.equal(Reports.annotationContributors(legacyAliasHistory).initial.name,'张明','existing non-Chinese legacy alias history is compatible');
const realLegacyTransfer = [
  ev('real-legacy-transfer','submit','2026-09-08T01:00:00Z',{actor:'成员01A',submissionKind:'initial'}),
  ev('real-legacy-transfer','qc_fail','2026-09-08T01:30:00Z',{actor:'组长',actorRole:'qc',pLevel:'P1'}),
  transfer('real-legacy-transfer','成员01A','李明','2026-09-08T02:00:00Z'),
  ev('real-legacy-transfer','submit','2026-09-08T03:00:00Z',{actor:'李明',actorRole:'annotation',previousAssignee:'成员01A',identityAlias:true,submissionKind:'rework'})
];
assert.equal(Reports.annotationContributors(realLegacyTransfer).initial.name,'成员01A','explicit real transfer overrides a misleading alias-shaped later field');
assert.deepEqual(Reports.annotationContributors(realLegacyTransfer).submissions.map(row=>row.name),['成员01A','李明']);
const chinesePrevious = [
  ev('chinese-previous','submit','2026-09-08T01:00:00Z',{actor:'张明',submissionKind:'initial'}),
  ev('chinese-previous','submit','2026-09-08T02:00:00Z',{actor:'李明',previousAssignee:'张明',submissionKind:'rework'})
];
assert.deepEqual(Reports.annotationContributors(chinesePrevious).submissions.map(row=>row.name),['张明','李明'],'a bare previousAssignee cannot merge two real Chinese names');

const assignmentRawTasks = [
  {id:'transfer-task',tid:'000081',movie:'转交测试影片',date:'2026-09-08',createdAt:'2026-09-08T01:00:00Z',groupId:'g1',mode:'single'},
  {id:'transfer-other-work',tid:'000082',movie:'转交测试影片',date:'2026-09-09',createdAt:'2026-09-09T01:00:00Z',groupId:'g1',mode:'single'},
  {id:'transfer-multi',tid:'900083',movie:'多镜隔离转交',date:'2026-09-08',createdAt:'2026-09-08T01:00:00Z',groupId:'g8',mode:'multi'}
];
const assignmentTasks = [
  {...assignmentRawTasks[0],status:'accepted',assignee:'王明',originalAssignee:'张明',previousAssignee:'李明',round:3,qcRound:3,acceptanceRound:2},
  {...assignmentRawTasks[1],status:'annotating',assignee:'张明',originalAssignee:'张明'},
  {...assignmentRawTasks[2],status:'rework',assignee:'多镜接手人',originalAssignee:'多镜原标注'}
];
const assignmentEvents = [...transferHistory,
  ev('transfer-other-work','claim','2026-09-09T02:00:00Z',{actor:'张明',actorRole:'annotation',assignee:'张明'}),
  transfer('transfer-multi','多镜原标注','多镜接手人','2026-09-09T01:00:00Z','rework',{groupId:'g8',mode:'multi',actor:'多镜分配组长'})
];
const assignmentInput = {state:{tasks:assignmentRawTasks,events:assignmentEvents,batches:[]},tasks:assignmentTasks,groups,mode:'single',statusMeta:input.statusMeta,localDate:input.localDate};
const assignmentBefore = JSON.stringify(assignmentInput);
const assignmentDay9 = Reports.groupDaily({...assignmentInput,date:'2026-09-09'}).find(row=>row.groupId==='g1');
assert.equal(assignmentDay9.autoHeadcount,2,'the original annotator working elsewhere and actual substitute are two people');
assert.deepEqual(new Set(assignmentDay9.members),new Set(['张明','李明']));
const assignmentOnlyDay = Reports.groupDaily({...assignmentInput,date:'2026-09-11'}).find(row=>row.groupId==='g1');
assert.equal(assignmentOnlyDay.autoHeadcount,0,'being assigned is not attendance; neither QC actor nor recipient is counted');
assert.deepEqual(assignmentOnlyDay.members,[]);
const assignmentReport = Reports.build(assignmentInput);
const assignedRow = assignmentReport.tasks.rows.find(row=>row.taskId==='transfer-task');
assert.equal(assignedRow.initialAnnotationName,'张明');assert.equal(assignedRow.initialAnnotationRawName,'张明');
assert.equal(assignedRow.assignee,'王明');assert.equal(assignedRow.originalAssignee,'张明');
assert.equal(assignedRow.assignmentCount,2);assert.equal(assignedRow.assignedFrom,'李明');assert.equal(assignedRow.assignedTo,'王明');
assert.equal(assignedRow.assignedBy,'分配组长');assert.equal(assignedRow.assignedAt,transferHistory[10].at);
assert.equal(assignedRow.assignmentReason,'请假代修,说明\n保留换行');assert.equal(assignedRow.assignmentStatus,'acceptance_rework');
assert.deepEqual(JSON.parse(assignedRow.reworkPeopleJSON),['李明','王明']);
assert.deepEqual(JSON.parse(assignedRow.assignmentsJSON),[transferHistory[4],transferHistory[10]]);
assert.deepEqual(JSON.parse(assignedRow.fullTimelineJSON),transferHistory);
assert.deepEqual(JSON.parse(assignedRow.originalTaskJSON),assignmentRawTasks[0]);
assert.equal(assignedRow.firstQcActor,'首检组长');assert.equal(assignedRow.firstQcPLevel,'P1');
assert.equal(assignedRow.submitRound,3);assert.equal(assignedRow.qcRound,3);
assert.equal(assignmentReport.tasks.rows.length,2);
assert.equal(JSON.stringify(assignmentReport).includes('多镜分配组长'),false);
const assignmentDaily = assignmentReport.daily.rows.find(row=>row.groupId==='g1'&&row.date==='2026-09-11');
assert.equal(assignmentDaily.assignmentActions,1);assert.equal(assignmentDaily.activeTIDs,0);
for(const key of ['importedTIDs','initialAnnotationTIDs','annotationReworkActions','qcPassActions','qcFailActions','completedTIDs','autoHeadcount']) assert.equal(assignmentDaily[key],0,`assignment-only day must not inflate ${key}`);
assert.equal(assignmentReport.daily.rows.reduce((sum,row)=>sum+row.completedTIDs,0),1,'later substitutions never re-count a first acceptance');
assert.equal(assignmentReport.daily.rows.reduce((sum,row)=>sum+row.initialAnnotationTIDs,0),1);
assert.equal(assignmentReport.daily.rows.reduce((sum,row)=>sum+row.annotationReworkActions,0),2);
const assignmentEventRow = assignmentReport.events.rows.find(row=>row.eventId===transferHistory[10].id);
assert.equal(assignmentEventRow.assignmentKind,'rework_transfer');assert.equal(assignmentEventRow.fromAssignee,'李明');
assert.equal(assignmentEventRow.assignee,'王明');assert.equal(assignmentEventRow.assignmentStatus,'acceptance_rework');
assert.deepEqual(JSON.parse(assignmentEventRow.rawJSON),transferHistory[10]);
for(const report of Object.values(assignmentReport)) for(const row of report.rows) assert.ok(report.columns.every(column=>Object.hasOwn(row,column.key)));
const assignmentCsv = IO.parseTable(IO.csv(assignmentReport.tasks.columns,assignmentReport.tasks.rows));
assert.equal(assignmentCsv.rows[0][assignmentCsv.headers.indexOf('TID')],'000081');
assert.equal(assignmentCsv.rows[0][assignmentCsv.headers.indexOf('最近代修原因')],'请假代修,说明\n保留换行');
assert.deepEqual(JSON.parse(assignmentCsv.rows[0][assignmentCsv.headers.indexOf('完整代修分配历史JSON')]),[transferHistory[4],transferHistory[10]]);
assert.equal(JSON.stringify(assignmentInput),assignmentBefore,'transfer reporting never changes original tasks, history, or backup data');
const aliasTask = {id:'alias-task',tid:'001',movie:'影片',groupId:'g1',mode:'single',date:'2026-09-08'};
const aliasInput = {state:{tasks:[aliasTask],events:aliasHistory,batches:[]},tasks:[aliasTask],groups,mode:'single',localDate:input.localDate,date:'2026-09-08'};
assert.deepEqual(Reports.groupDaily(aliasInput)[0].members,['张明']);
assert.equal(Reports.groupDaily(aliasInput)[0].autoHeadcount,1,'explicit old-name continuation remains a single person');
const realLegacyTask = {...aliasTask,id:'real-legacy-transfer'};
assert.equal(Reports.groupDaily({...aliasInput,state:{tasks:[realLegacyTask],events:realLegacyTransfer,batches:[]},tasks:[realLegacyTask]})[0].autoHeadcount,2,'real transfer from a legacy-named person is not inferred as an identity alias');
const assignmentOnlyReport = Reports.build({...assignmentInput,tasks:[assignmentTasks[2]],mode:'multi'});
assert.equal(assignmentOnlyReport.tasks.rows[0].claimedAt,'','a partial history containing only a transfer must not invent a first annotation claim');
assert.equal(assignmentOnlyReport.tasks.rows[0].initialAnnotationName,'');
assert.equal(assignmentOnlyReport.tasks.rows[0].assignedBy,'多镜分配组长');

// A cached v1 page can still append its original owner's raw actions. Shared
// workflow conflict decisions must also govern every report, never the backup.
const conflictId = 'conflict-transfer';
const conflictBase = [
  ev(conflictId,'dispatch','2026-09-08T01:00:00Z'),
  ev(conflictId,'claim','2026-09-08T02:00:00Z',{actor:'张明',assignee:'张明'}),
  ev(conflictId,'submit','2026-09-08T03:00:00Z',{actor:'张明',assignee:'张明',round:1,submissionKind:'initial'}),
  ev(conflictId,'qc_fail','2026-09-08T04:00:00Z',{actor:'首检组长',round:1,pLevel:'P1',tags:['补标缺失'],note:'有效首检'}),
  transfer(conflictId,'张明','李明','2026-09-09T01:00:00Z')
];
const oldAClaim = ev(conflictId,'claim','2026-09-09T02:00:00Z',{actor:'张明',assignee:'张明'});
const oldASubmit = ev(conflictId,'submit','2026-09-09T02:01:00Z',{actor:'张明',round:2,submissionKind:'rework',note:'最初 a 页面原人提交，原始记录保留'});
const oldAReject = ev(conflictId,'annotator_reject','2026-09-09T02:02:00Z',{actor:'张明',note:'旧人拒绝'});
const oldQcFail = ev(conflictId,'qc_fail','2026-09-09T02:03:00Z',{actor:'旧质检',round:1,pLevel:'P2',tags:['旧页错误'],note:'过时审核不得替代最近有效结果'});
const oldAcceptancePass = ev(conflictId,'acceptance_pass','2026-09-09T02:04:00Z',{actor:'旧验收',round:1});
const oldAcceptanceFail = ev(conflictId,'acceptance_fail','2026-09-09T02:05:00Z',{actor:'旧验收',round:1});
const oldSent = ev(conflictId,'sent_acceptance','2026-09-09T02:06:00Z',{actor:'旧质检'});
const correctBSubmit = ev(conflictId,'submit','2026-09-09T03:00:00Z',{actor:'李明',assignee:'李明',round:2,submissionKind:'rework',note:'当前接手人用旧页有效提交'});
const oldQcPass = ev(conflictId,'qc_pass','2026-09-09T03:01:00Z',{actor:'旧质检',round:1});
const duplicateB = ev(conflictId,'submit','2026-09-09T03:02:00Z',{actor:'李明',assignee:'李明',round:2,submissionKind:'rework'});
const modernWrongA = ev(conflictId,'submit','2026-09-10T01:00:00Z',{actor:'张明',assignee:'张明',actorRole:'annotation',workflowVersion:3,submissionKind:'rework'});
const rejectedRecords = [oldAClaim,oldASubmit,oldAReject,oldQcFail,oldAcceptancePass,oldAcceptanceFail,oldSent,oldQcPass,duplicateB,modernWrongA];
const conflictHistory = [...conflictBase,oldAClaim,oldASubmit,oldAReject,oldQcFail,oldAcceptancePass,oldAcceptanceFail,oldSent,correctBSubmit,oldQcPass,duplicateB,modernWrongA];
const conflictRawTasks = [
  {id:conflictId,tid:'000091',movie:'冲突统计影片',date:'2026-09-08',groupId:'g1',mode:'single',createdAt:'2026-09-08T01:00:00Z'},
  {id:'untransferred-task',tid:'000092',movie:'普通旧任务',date:'2026-09-09',groupId:'g1',mode:'single',createdAt:'2026-09-09T01:00:00Z'},
  {id:'conflict-multi',tid:'900093',movie:'其他模块原始记录',date:'2026-09-09',groupId:'g8',mode:'multi',createdAt:'2026-09-09T01:00:00Z'}
];
const untransferredHistory = [ev('untransferred-task','submit','2026-09-09T04:00:00Z',{actor:'另位同学',submissionKind:'initial'}),ev('untransferred-task','acceptance_pass','2026-09-09T05:00:00Z',{actor:'普通旧验收'})];
const allConflictEvents = [...conflictHistory,...untransferredHistory,ev('conflict-multi','submit','2026-09-09T01:00:00Z',{actor:'多镜原始标注'})];
const conflictTasks = conflictRawTasks.map(task=>({...task,...Flow.project(task,allConflictEvents.filter(event=>event.taskId===task.id))}));
const conflictInput = {state:{tasks:conflictRawTasks,events:allConflictEvents,batches:[]},tasks:conflictTasks,groups,mode:'single',statusMeta:Flow.STATUS_META,localDate:input.localDate};
const conflictBefore = JSON.stringify(conflictInput);
const effective = Flow.effectiveEvents(conflictHistory);
assert.deepEqual(effective.map(event=>event.id),[...conflictBase,correctBSubmit].map(event=>event.id));
assert.ok(effective.every(event=>conflictHistory.includes(event)),'shared filtering retains original event references');
assert.deepEqual(Flow.effectiveEvents(untransferredHistory),untransferredHistory,'ordinary legacy tasks retain their prior behavior');
const effectiveContribution = Reports.annotationContributors(conflictHistory);
assert.equal(effectiveContribution.initial.name,'张明');assert.equal(effectiveContribution.firstQc.name,'张明');
assert.equal(effectiveContribution.firstQc.pLevel,'P1');
assert.deepEqual(effectiveContribution.rework.map(person=>[person.name,person.count]),[['李明',1]],'old A submission and duplicate B submission cannot inflate either person');
assert.equal(effectiveContribution.firstAcceptance,null,'stale acceptance cannot invent completed output');
assert.equal(Reports.qcOperator(conflictHistory).name,'分配组长','stale audits cannot replace the actual most recent QC operator');
const conflictPeople = Reports.groupDaily({...conflictInput,date:'2026-09-09'}).find(row=>row.groupId==='g1');
assert.deepEqual(new Set(conflictPeople.members),new Set(['李明','另位同学']));
assert.equal(conflictPeople.autoHeadcount,2,'ignored original-owner activity never adds attendance');
assert.equal(Reports.groupDaily({...conflictInput,date:'2026-09-10'}).find(row=>row.groupId==='g1').autoHeadcount,0,'even a modern wrong-owner event is excluded from attendance');
const conflictReport = Reports.build(conflictInput), conflictRow = conflictReport.tasks.rows.find(row=>row.taskId===conflictId);
assert.equal(conflictRow.status,'annotation_rework_done');assert.equal(conflictRow.assignee,'李明');assert.equal(conflictRow.submitRound,2);
assert.equal(conflictRow.firstQcPLevel,'P1');assert.equal(conflictRow.latestQcPLevel,'P1');assert.equal(conflictRow.latestQcActor,'首检组长');
assert.equal(conflictRow.qcOperator,'分配组长');assert.equal(conflictRow.excludedEventCount,rejectedRecords.length);
assert.deepEqual(new Set(JSON.parse(conflictRow.excludedEventsJSON).map(item=>item.eventId)),new Set(rejectedRecords.map(event=>event.id)));
assert.ok(JSON.parse(conflictRow.excludedEventsJSON).every(item=>item.taskId===conflictId&&item.reason));
assert.deepEqual(JSON.parse(conflictRow.fullTimelineJSON),conflictHistory,'complete raw timeline remains available including every conflict');
assert.deepEqual(JSON.parse(conflictRow.originalTaskJSON),conflictRawTasks[0]);
const conflictDay = conflictReport.daily.rows.find(row=>row.date==='2026-09-09'&&row.groupId==='g1');
assert.equal(conflictDay.annotationReworkActions,1);assert.equal(conflictDay.qcFailActions,0);assert.equal(conflictDay.qcPassActions,0);
assert.equal(conflictDay.acceptanceFailActions,0);assert.equal(conflictDay.completedTIDs,1,'only the unchanged unrelated task contributes completed TIDs');
assert.equal(conflictDay.initialAnnotationTIDs,1);assert.equal(conflictDay.activeTIDs,2);
assert.equal(conflictReport.daily.rows.filter(row=>row.date==='2026-09-10').length,0,'a conflict-only date creates no output row');
assert.equal(conflictReport.events.rows.filter(row=>row.taskId===conflictId).length,conflictHistory.length,'event export never deletes rejected raw records');
for(const rejectedEvent of rejectedRecords) {
  const row = conflictReport.events.rows.find(row=>row.eventId===rejectedEvent.id);
  assert.equal(row.excludedFromProgress,true);assert.ok(row.excludedReason);
  assert.deepEqual(JSON.parse(row.rawJSON),rejectedEvent);
}
assert.equal(conflictReport.events.rows.find(row=>row.eventId===correctBSubmit.id).excludedFromProgress,false);
assert.equal(conflictReport.events.rows.find(row=>row.eventId===correctBSubmit.id).excludedReason,'');
assert.equal(conflictReport.tasks.rows.find(row=>row.taskId==='untransferred-task').excludedEventCount,0);
assert.equal(JSON.stringify(conflictReport).includes('多镜原始标注'),false,'conflict annotations respect module scope');
const conflictCsv = IO.parseTable(IO.csv(conflictReport.events.columns,conflictReport.events.rows));
const rawIndex = conflictCsv.headers.indexOf('完整原始事件JSON'), excludedIndex = conflictCsv.headers.indexOf('是否未计入进度');
const oldCsv = conflictCsv.rows.find(row=>JSON.parse(row[rawIndex]).id===oldASubmit.id);
assert.equal(oldCsv[excludedIndex],'true');assert.deepEqual(JSON.parse(oldCsv[rawIndex]),oldASubmit);
for(const report of Object.values(conflictReport)) for(const row of report.rows) assert.ok(report.columns.every(column=>Object.hasOwn(row,column.key)));
assert.equal(JSON.stringify(conflictInput),conflictBefore,'shared filtering and every export leave full original state unchanged for backup');
const browserReportsContext = {window:{WorkbenchFlow:Flow}};
require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../group-workbench-beta/reports.js'),'utf8'),browserReportsContext);
assert.equal(JSON.stringify(browserReportsContext.window.WorkbenchReports.annotationContributors(conflictHistory)),JSON.stringify(effectiveContribution),'browser global dependency and CommonJS dependency apply identical conflict filtering');
assert.equal(browserReportsContext.window.WorkbenchReports.qcOperator(conflictHistory).name,'分配组长');

g1day8.history[0].after.total=99999;
assert.equal(JSON.stringify(staffInput),staffBefore,'returned histories are detached from stored settings');
console.log('Workbench report checks passed: exact TIDs and histories, scoped exports, first QC tags, local-day stats, partial packs, group/day overrides, empty groups, alias headcounts, half-person values, null auto reset, leader carry-forward, cumulative person-days, whole-film seed guards, cross-date/group progress, closure/reopening, real transfers, cached-page conflict exclusion, complete raw CSV, module isolation and immutable inputs.');
