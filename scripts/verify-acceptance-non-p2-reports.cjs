'use strict';
// Offline comparison against the released prod83 report module; synthetic data only.
process.env.TZ='UTC';
const assert=require('node:assert/strict');
const Reports=require('../group-workbench/reports.js');
const Baseline=require('../group-workbench/reports.20261027-prod83-p2-volume.js');
const Flow=require('../group-workbench/workflow.js'),IO=require('../group-workbench/data-io.js');
const {createExporter}=require('../group-workbench/export-worker.js');
const {fixture}=require('./verify-acceptance-p2-reports.cjs');
const rateColumn='非P2率（非P2/实际验收TID）';
const counts=({total,p2Count,nonP2Count,rate})=>({total,p2Count,nonP2Count,rate});
let comparisons=0;
function unchangedOriginal(value) {
  if(Array.isArray(value))return value.map(unchangedOriginal);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!['acceptanceP2Rate','acceptanceNonP2TIDs'].includes(key))
    .map(([key,item])=>[key,key==='columns'?item.filter(column=>!['acceptanceP2Rate','acceptanceNonP2TIDs'].includes(column.key)):unchangedOriginal(item)]));
}
function compare(input) {
  assert.deepEqual(Reports.acceptanceAccuracy(input),Baseline.acceptanceAccuracy(input),'all original first-accuracy fields stay identical');comparisons++;
  assert.deepEqual(unchangedOriginal(Reports.build(input)),unchangedOriginal(Baseline.build(input)),'only the current non-P2 fields change in full exports');comparisons++;
  const old=Baseline.acceptanceP2(input),current=Reports.acceptanceP2(input);
  assert.equal(current.total,old.total);assert.equal(current.p2Count,old.p2Count);
  assert.deepEqual(current.rows.map(({isNonP2,...row})=>row),old.rows,'inclusion, date, owner and dedup details remain identical');comparisons++;
  assert.equal(current.nonP2Count,current.total-current.p2Count);
  assert.equal(current.rate,current.total?current.nonP2Count/current.total*100:null);
  assert.deepEqual(Reports.acceptanceP2({...input,includeRows:false}),{...counts(current),rows:[]});
  current.rows.forEach(row=>assert.equal(row.isNonP2,!row.isP2));
  return current;
}
async function main() {
  const scenarios=[];
  for(const mode of ['single','multi']) {
    const f=fixture(mode);
    for(let index=0;index<31;index++) {
      const id=`sample-${index}`;f.addTask(id);
      f.verdict(id,index===30?'fail':'pass',index<2?{acceptanceIssueLevel:'P2'}:{});
    }
    const original=JSON.stringify(f.state),input=f.input(),value=compare(input);
    assert.equal(value.total,31);assert.equal(value.p2Count,2);assert.equal(value.nonP2Count,29);assert.equal(value.rate.toFixed(1),'93.5');
    assert.equal(value.rows.find(row=>row.tid==='TID-sample-30').isNonP2,true,'ordinary actual failure is non-P2, not an acceptance pass');
    assert.equal(Reports.acceptanceAccuracy(input).passed,30);
    const worker=createExporter(Flow,Reports,IO);
    const csv=async(kind)=>{
      const file=worker.generate({kind,groups:input.groups,statusMeta:Flow.STATUS_META,eventLabels:{},scope:{profile:{role:'admin'},mode,groupId:f.groupId,range:'scope',dateFrom:'2026-10-26',dateTo:'2026-10-26'}},f.state);
      const parsed=IO.parseTable(await file.blob.text()),headers=parsed.records[0].cells;
      return parsed.records.slice(1).map(row=>Object.fromEntries(headers.map((key,index)=>[key,row.cells[index]])));
    };
    const detail=await csv('acceptanceP2');assert.equal(detail.length,31);
    assert.equal(detail.filter(row=>row['是否发生P2']==='是').length,2);
    assert.equal(detail.filter(row=>row['是否非P2']==='是').length,29);
    assert.equal(detail.find(row=>row.TID==='TID-sample-30')['是否非P2'],'是');
    for(const kind of ['groups','movies','daily']) {
      const rows=await csv(kind),row=rows.find(item=>item[rateColumn]!=='');
      assert.equal(row[rateColumn],'93.5%');
      assert.equal(row[kind==='daily'?'非P2实检TID（含复验，日内去重）':'非P2实检TID（含复验，区间去重）'],'29');
      assert.equal(row['首轮P2占比（原首轮口径）'],'6.5%','legacy first-round P2 share is not inverted');
    }
    for(const scope of [
      {dateFrom:'2026-10-26',dateTo:'2026-10-26'},
      {dateFrom:'2026-10-25',dateTo:'2026-10-27'},
      {groupId:f.groupId}, {groupId:mode==='multi'?'g07':'g02'},
      {mode:mode==='multi'?'single':'multi'},
      {dateFrom:'2026-10-28',dateTo:'2026-10-28'}
    ])compare(f.input(scope));
    assert.equal(JSON.stringify(f.state),original,'calculating/exporting cannot mutate source events');
    scenarios.push({mode,total:value.total,p2:value.p2Count,nonP2:value.nonP2Count,nonP2Rate:`${value.rate.toFixed(1)}%`,firstAccuracy:`${Reports.acceptanceAccuracy(input).rate.toFixed(1)}%`});
  }
  for(const [name,p2Count,total,expected] of [['no-p2',0,4,100],['all-p2',4,4,0],['empty',0,0,null]]) {
    const f=fixture();for(let index=0;index<total;index++){f.addTask(`edge-${index}`);f.verdict(`edge-${index}`,'pass',index<p2Count?{acceptanceIssueLevel:'P2'}:{});}
    const value=compare(f.input());assert.equal(value.rate,expected,name);
    const summary=Reports.build(f.input()).groups.rows.find(row=>row.groupId===f.groupId);
    assert.equal(summary.acceptanceP2Rate,expected===null?'':`${expected.toFixed(1)}%`);
    scenarios.push({name,...counts(value)});
  }
  const f=fixture();f.addTask('repair');f.verdict('repair','fail');
  const first=Reports.acceptanceAccuracy(f.input());
  f.addEvent('repair','acceptance_route',{at:'2026-10-27T09:00:00+08:00',actorRole:'qc',route:'qc'});
  f.addEvent('repair','qc_repair_done',{at:'2026-10-27T09:00:00+08:00',actorRole:'qc'});
  f.verdict('repair','pass',{at:'2026-10-27T09:00:00+08:00',acceptanceRound:2,acceptanceIssueLevel:'P2'});
  f.verdict('repair','pass',{at:'2026-10-28T09:00:00+08:00',acceptanceRound:3});
  for(const [dateFrom,dateTo,rate] of [['2026-10-26','2026-10-26',100],['2026-10-27','2026-10-27',0],['2026-10-28','2026-10-28',100],['2026-10-26','2026-10-28',0]]) {
    const value=compare(f.input({dateFrom,dateTo}));assert.equal(value.total,1);assert.equal(value.rate,rate,'any P2 inside the selected range excludes the TID from non-P2');
  }
  assert.deepEqual(Reports.acceptanceAccuracy(f.input()),first,'reinspection never changes first acceptance accuracy');
  console.log(JSON.stringify({ok:true,comparisons,scenarios,checks:['2 of 31 is 93.5%','0 of N is 100%','N of N is 0%','empty is null/blank','ordinary fail is non-P2','cross-day/reinspection dedup unchanged','first accuracy and old first P2 share unchanged','single/multi/group/date CSV parity','source data immutable']}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
