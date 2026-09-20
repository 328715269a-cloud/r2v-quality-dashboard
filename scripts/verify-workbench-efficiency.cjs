'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const Reports=require('../group-workbench/reports.js');
const Flow=require('../group-workbench/workflow.js');
const IO=require('../group-workbench/data-io.js');
let sequence=0;
const groups=[{id:'g01',defaultMode:'single',leader:'组长'},{id:'g02',defaultMode:'single',leader:'二组长'},{id:'g06',defaultMode:'multi',leader:'多组长'}];
const day1='2026-09-18',day2='2026-09-19',day3='2026-09-20';
const localDate=value=>new Date(Date.parse(value)+8*3600000).toISOString().slice(0,10);
const at=(date,hour='09:00:00')=>`${date}T${hour}+08:00`;
const task=(id,groupId='g01',mode='single')=>({id,tid:`TID-${id}`,movie:'效率验证影片',groupId,mode,date:'2020-01-01',createdAt:at(day1,'08:00:00')});
const event=(taskId,type,date,details={})=>({id:`event-${++sequence}`,taskId,type,at:at(date),actor:'张明',actorRole:'annotation',workflowVersion:3,...details});
const setting=(date,total,headcount,details={})=>event('group:g01','group_daily_edit',date,{actor:'组长',actorRole:'qc',groupId:'g01',mode:'single',date,after:{leader:'组长',total,headcount},...details});
const claim=(id,name,date,details={})=>event(id,'claim',date,{actor:name,assignee:name,...details});
const submit=(id,name,date,kind='initial',details={})=>event(id,'submit',date,{actor:name,assignee:name,submissionKind:kind,...details});
const tasks=[task('a'),task('b'),task('claim-only'),task('other','g02'),task('multi','g06','multi'),{...task('deleted'),deleted:true}];
const events=[
  claim('a','张明',day1),submit('a','张明',day1),submit('a','张明',day1,'initial',{at:at(day1,'10:00:00')}),
  submit('a','张明',day2,'rework'),
  claim('b','临时01',day1),submit('b','临时01',day1),
  submit('b','王明',day2,'rework',{previousAssignee:'临时01',identityAlias:true}),
  claim('claim-only','罗明',day3),
  submit('other','他组成员',day1),submit('multi','多镜成员',day1),submit('deleted','已删成员',day1),
  event('a','submit',day3,{actor:'伪标注质检',actorRole:'qc'}),
  setting(day1,9000,1.5),setting(day3,8000,4)
];
const input={state:{tasks,events,batches:[]},tasks,groups,mode:'single',localDate};
const before=JSON.stringify(input);
const groupRow=(value,date)=>Reports.groupDaily({...value,date}).find(row=>row.groupId==='g01');
const range=(value,dateFrom=day1,dateTo=day3)=>Reports.groupDaily({...value,dateFrom,dateTo}).find(row=>row.groupId==='g01');
const first=groupRow(input,day1),second=groupRow(input,day2),third=groupRow(input,day3);
assert.equal(first.completedTIDs,2,'repeated same-day submit must not inflate completed TIDs');
assert.equal(first.initialSubmissionTIDs,2,'later submit incorrectly labelled initial is still rework');
assert.equal(first.reworkSubmissionActions,1);assert.equal(first.autoHeadcount,2,'continued legacy identity counts once');
assert.equal(first.headcount,1.5);assert.equal(first.personDayEfficiency,2/1.5);assert.equal(first.total,9000,'manual total remains audit-only');
assert.equal(second.total,null,'missing manual total has no effect on actual submission efficiency');
assert.equal(second.completedTIDs,2);assert.equal(second.initialSubmissionTIDs,0);assert.equal(second.reworkSubmissionActions,2);assert.equal(second.headcount,2);assert.equal(second.personDayEfficiency,1);
assert.equal(third.completedTIDs,0);assert.equal(third.headcount,4);assert.equal(third.personDayEfficiency,0,'staffed zero-output day is a real zero');
const whole=range(input);assert.equal(whole.completedTIDs,4,'same TID done on different days contributes to each workday');
assert.equal(whole.headcount,7.5);assert.equal(whole.personDayEfficiency,4/7.5,'aggregate sums daily completed TIDs and daily attendance, never averages daily rates');
assert.equal(whole.initialSubmissionTIDs,2);assert.equal(whole.reworkSubmissionActions,3);assert.equal(whole.efficiencyIssue,'');
assert.deepEqual(Reports.groupDaily({...input,dateFrom:day1,dateTo:day1}),Reports.groupDaily({...input,date:day1}));
assert.equal(range(input,day2,day3).personDayEfficiency,2/6,'date range is inclusive and does not use task allocation date');

const people=Reports.personDaily({...input,groupId:'g01',dateFrom:day1,dateTo:day3});
const person=(name,date)=>people.find(row=>row.name===name&&row.date===date);
assert.equal(person('张明',day1).completedTIDs,1);assert.equal(person('张明',day1).submissionActions,2);assert.equal(person('张明',day1).reworkSubmissionActions,1);
assert.equal(person('王明',day1).completedTIDs,1);assert.deepEqual(person('王明',day1).rawNames,['临时01']);
assert.equal(person('王明',day2).completedTIDs,1);assert.equal(person('王明',day2).initialSubmissionTIDs,0);
assert.equal(person('罗明',day3).completedTIDs,0,'claim-only attendance does not invent output');
assert(!people.some(row=>['已删成员','他组成员','多镜成员','伪标注质检'].includes(row.name)));
assert.deepEqual(Reports.personDaily({...input,groupId:'g01',date:day2}),people.filter(row=>row.date===day2));
assert.deepEqual(Reports.personDaily({...input,groups:[groups[1]]}).map(row=>row.name),['他组成员']);
assert.deepEqual(Reports.personDaily({...input,tasks:[tasks[0]],groups:[groups[0]]}).map(row=>[row.name,row.date]),[['张明',day1],['张明',day2]],'supplied tasks are an independent privacy boundary');
assert.deepEqual(Reports.personDaily({...input,mode:'multi'}).map(row=>row.name),['多镜成员']);
assert.deepEqual(Reports.personDaily({...input,dateFrom:'',dateTo:'',date:'2000-01-01'}),Reports.personDaily(input),'explicit all-date range overrides stale date');
assert.throws(()=>Reports.personDaily({...input,dateFrom:day3,dateTo:day1}),RangeError);
assert.throws(()=>Reports.personDaily({...input,dateFrom:'2026-02-30'}),RangeError);
assert.equal(JSON.stringify(input),before,'new reports never mutate tasks, settings, events or identity history');

const zeroInput={...input,state:{...input.state,events:[...events,setting(day2,12345,0)]}};
const zeroDay=groupRow(zeroInput,day2),zeroRange=range(zeroInput);
assert.equal(zeroDay.completedTIDs,2);assert.equal(zeroDay.personDayEfficiency,null);assert.equal(zeroDay.efficiencyIssue,'completed_without_headcount');
assert.deepEqual(zeroDay.efficiencyIssueDates,[day2]);assert.equal(zeroRange.personDayEfficiency,null,'positive attendance on another day cannot hide a zero-staff output day');
assert.deepEqual(zeroRange.efficiencyIssueDates,[day2]);assert.equal(zeroRange.headcount,5.5);
const noStaff=groupRow(input,'2026-09-21');assert.equal(noStaff.completedTIDs,0);assert.equal(noStaff.personDayEfficiency,null);assert.equal(noStaff.efficiencyIssue,'no_person_days');
const noStaffRange=range(input,'2026-09-21','2026-09-22');assert.equal(noStaffRange.personDayEfficiency,null);assert.equal(noStaffRange.efficiencyIssue,'no_person_days');
const noOutputZero={...input,state:{...input.state,events:[...events,setting(day3,8000,0)]}};
assert.equal(range(noOutputZero).personDayEfficiency,4/3.5,'zero-output zero-attendance day contributes neither numerator nor denominator');

const transferTask=task('transfer');
const transferEvents=[claim('transfer','张明',day1),submit('transfer','张明',day1),event('transfer','qc_fail',day1,{actor:'质检员',actorRole:'qc',pLevel:'P1'}),
  event('transfer','claim',day2,{actor:'分配组长',actorRole:'qc',workflowVersion:4,assignmentKind:'rework_transfer',fromAssignee:'张明',assignee:'李明',assignmentStatus:'rework',note:'请假代修'}),
  submit('transfer','张明',day2,'rework',{round:2}),
  submit('transfer','李明',day2,'rework',{round:2}),
  submit('transfer','李明',day2,'rework',{round:3})];
const transferInput={...input,tasks:[transferTask],state:{tasks:[transferTask],events:transferEvents,batches:[]}};
const transferPeople=Reports.personDaily(transferInput);
assert.deepEqual(transferPeople.map(row=>[row.name,row.date,row.completedTIDs,row.reworkSubmissionActions]),[['张明',day1,1,0],['李明',day2,1,1]],'actual substitute receives rework; group assignment and cached old-owner/duplicate submits do not create work');
assert.equal(groupRow(transferInput,day2).autoHeadcount,1);assert.equal(groupRow(transferInput,day2).completedTIDs,1);
assert.equal(groupRow(transferInput,day2).reworkSubmissionActions,1);assert.equal(Reports.annotationContributors(transferEvents).rework[0].name,'李明');
const sameDayTransfer={...transferInput,state:{...transferInput.state,events:transferEvents.map(e=>({...e,at:at(day1)}))}};
assert.equal(groupRow(sameDayTransfer,day1).completedTIDs,1);
assert.equal(Reports.personDaily(sameDayTransfer).reduce((sum,row)=>sum+row.completedTIDs,0),2,'same TID can be actual work of two people but counts once for that group/day');
const realLegacyEvents=transferEvents.map(e=>({...e,actor:e.actor==='张明'?'旧成员01':e.actor,assignee:e.assignee==='张明'?'旧成员01':e.assignee,fromAssignee:e.fromAssignee==='张明'?'旧成员01':e.fromAssignee}));
realLegacyEvents[5]={...realLegacyEvents[5],previousAssignee:'旧成员01',identityAlias:true};
assert.deepEqual(Reports.personDaily({...transferInput,state:{...transferInput.state,events:realLegacyEvents}}).map(row=>row.name),['旧成员01','李明'],'true transfer blocks misleading alias-shaped metadata');

const midnightTask=task('midnight');
const midnightInput={...input,tasks:[midnightTask],state:{tasks:[midnightTask],events:[submit('midnight','午夜标注',day1,'initial',{at:'2026-09-18T16:30:00.000Z'})],batches:[]}};
assert.equal(Reports.personDaily(midnightInput)[0].date,day2);assert.equal(groupRow(midnightInput,day1).completedTIDs,0);assert.equal(groupRow(midnightInput,day2).completedTIDs,1);

const report=Reports.build({...input,statusMeta:Flow.STATUS_META,groupLabel:id=>`小组${id}`});
for(const [name,sheet] of Object.entries(report)){
  assert.equal(new Set(sheet.columns.map(column=>column.key)).size,sheet.columns.length,`${name} column keys must be unique`);
  for(const row of sheet.rows)assert(sheet.columns.every(column=>Object.hasOwn(row,column.key)),`${name} every export column must have a defined row field`);
}
const daily=report.daily.rows.find(row=>row.groupId==='g01'&&row.date===day1);
assert.equal(daily.annotationCompletedTIDs,2);assert.equal(daily.completedTIDs,0,'existing completedTIDs remains first acceptance pass, never overwritten');
assert.equal(daily.personDayEfficiency,2/1.5);assert.equal(report.groups.rows.find(row=>row.groupId==='g01').annotationCompletedTIDs,4);
assert.equal(report.groups.rows.find(row=>row.groupId==='g01').personDayEfficiency,4/7.5);
assert(!report.personDaily.rows.some(row=>row.mode==='多镜头'||row.name==='已删成员'));
const csv=IO.parseTable(IO.csv(report.personDaily.columns,report.personDaily.rows));assert.equal(csv.records.length,report.personDaily.rows.length+1);
const exported=report.personDaily.rows.find(row=>row.name==='张明'&&row.date===day1);
assert.deepEqual(JSON.parse(exported.tidsJSON),['TID-a']);assert.equal(JSON.parse(exported.eventIdsJSON).length,2);
const singleTaskReport=Reports.build({...input,tasks:[tasks[0]],groups:[groups[0]]});assert(singleTaskReport.personDaily.rows.every(row=>row.name==='张明'));
assert.equal(JSON.stringify(input),before);

const result={ok:true,checkedAt:new Date().toISOString(),checks:['daily TID deduplication','weighted daily attendance incl 0.5','manual total excluded','missing manual total irrelevant','zero-headcount completion invalidates whole range','actual per-person submit ownership','real transfer and legacy alias distinction','stale conflicting records excluded','claim-only zero output','China local-day boundary','mode/group/task boundaries','new and legacy export semantics preserved','all export columns unique','immutable source records'],sourceHash:crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../group-workbench/reports.js'))).digest('hex')};
if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
