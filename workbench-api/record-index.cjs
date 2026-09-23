'use strict';

const Flow=require('../group-workbench/workflow.js');

// This is a disposable read index, never a second source of truth. Call sync
// inside a SQLite read snapshot; the maintenance barrier invalidates every map.
function createRecordIndex(db){
  const read=db.prepare('SELECT kind,revision,json FROM records WHERE revision>? ORDER BY revision,ordinal');
  let revision=-1,barrier=-1,tasks,histories,groups,order,tail,owners,taskTids,duplicates;
  const stats={rebuilds:0,recordsRead:0,projectedTasks:0,relatedTransactions:0,relatedTasks:0,relatedEvents:0,scopedRecordsRead:0};
  function reset(){tasks=new Map();histories=new Map();groups=new Map();order=new Map();tail=[];owners=new Map();taskTids=new Map();duplicates=new Set();}
  reset();
  function groupRows(key){if(!groups.has(key))groups.set(key,{tasks:[],events:[],batches:[]});return groups.get(key);}
  function syncRows(nextRevision,nextBarrier){
    const rebuild=revision<0||barrier!==nextBarrier||revision>nextRevision;
    if(rebuild){reset();revision=-1;stats.rebuilds+=1;}
    if(revision===nextRevision){barrier=nextBarrier;return;}
    const changed=new Set();
    for(const row of read.all(revision)){
      const value=JSON.parse(row.json);stats.recordsRead+=1;
      const keys=new Set();if(value.groupId)keys.add(value.groupId);
      if(row.kind==='tasks'){
        tasks.set(value.id,value);histories.set(value.id,[]);changed.add(value.id);
      }else if(row.kind==='events'){
        order.set(value.id,order.size);tail.push(value);if(tail.length>10)tail.shift();
        const task=tasks.get(value.taskId);if(task){histories.get(task.id).push(value);changed.add(task.id);keys.add(task.groupId);}
      }else if(row.kind==='batches'){
        for(const taskId of value.taskIds||[]){const task=tasks.get(taskId);if(task)keys.add(task.groupId);}
      }
      for(const key of keys)groupRows(key)[row.kind].push({revision:row.revision,value});
    }
    // Remove all old names before adding new names, so one atomic metadata edit
    // that swaps two TIDs is not mistaken for a duplicate.
    for(const taskId of changed){const old=taskTids.get(taskId);if(old!==undefined){const set=owners.get(old);set.delete(taskId);if(!set.size)owners.delete(old);if(set.size<2)duplicates.delete(old);taskTids.delete(taskId);}}
    for(const taskId of changed){
      const task=tasks.get(taskId),view={...task,...Flow.project(task,histories.get(taskId))};stats.projectedTasks+=1;
      if(view.deleted)continue;const tid=view.tid.toUpperCase();if(!owners.has(tid))owners.set(tid,new Set());
      owners.get(tid).add(taskId);taskTids.set(taskId,tid);if(owners.get(tid).size>1)duplicates.add(tid);
    }
    revision=nextRevision;barrier=nextBarrier;
  }
  function sync(nextRevision,nextBarrier){
    try{syncRows(nextRevision,nextBarrier);}catch(error){reset();revision=-1;barrier=-1;throw error;}
  }
  function related(delta){
    const ids=new Set(delta.events.map(event=>event.taskId)),selectedTasks=[],selectedEvents=[];
    for(const id of ids){if(tasks.has(id))selectedTasks.push(tasks.get(id));selectedEvents.push(...(histories.get(id)||[]));}
    selectedEvents.sort((a,b)=>order.get(a.id)-order.get(b.id));
    stats.relatedTransactions+=1;stats.relatedTasks+=selectedTasks.length;stats.relatedEvents+=selectedEvents.length;
    return{tasks:selectedTasks,events:selectedEvents,batches:[]};
  }
  function scoped(groupId,after){
    const source=groups.get(groupId)||{tasks:[],events:[],batches:[]},out={tasks:[],events:[],batches:[]};
    for(const kind of ['tasks','events','batches']){
      const rows=source[kind];let low=0,high=rows.length;
      while(low<high){const middle=Math.floor((low+high)/2);if(rows[middle].revision<=after)low=middle+1;else high=middle;}
      for(let index=low;index<rows.length;index++){
        stats.scopedRecordsRead+=1;const value=rows[index].value;
        out[kind].push(kind==='batches'?{...value,taskIds:(value.taskIds||[]).filter(id=>tasks.get(id)?.groupId===groupId)}:value);
      }
    }
    return out;
  }
  return{sync,related,scoped,matches:(r,b)=>revision===r&&barrier===b,hasDuplicateTids:()=>duplicates.size>0,clockEvents:()=>tail,stats:()=>({...stats,revision,barrier})};
}

module.exports={createRecordIndex};
