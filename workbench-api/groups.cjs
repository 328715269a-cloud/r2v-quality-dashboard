'use strict';

// The built-in directory remains stable for existing task IDs and sessions.
// s06 is a historical API-only ID; keep it valid without exposing a new team.
const BUILTIN_GROUPS=Object.freeze([
  ...[1,2,3,4,5].map(number=>Object.freeze({id:'g0'+number,name:`单镜头${number}组`,defaultMode:'single',...(number===5?{retired:true}:{})})),
  Object.freeze({id:'s06',name:'单镜头6组',defaultMode:'single',retired:true}),
  ...[1,2,3,4,5,6,7,8,9,10,11,12].map(number=>Object.freeze({id:number<=5?'g'+String(number+5).padStart(2,'0'):'m'+String(number).padStart(2,'0'),name:`多镜头${number}组`,defaultMode:'multi'})),
  Object.freeze({id:'m_newcomer',name:'多镜头新人组',defaultMode:'multi'})
]);
const GROUP_ID=/^group_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const groupName=value=>String(value??'').trim().normalize('NFC');
const groupNameKey=value=>groupName(value).normalize('NFKC').replace(/\s+/gu,'').toLowerCase();
const groupModes=groups=>Object.freeze(Object.fromEntries(groups.map(group=>[group.id,group.defaultMode])));
function appendGroup(groups,event){
  const value={id:event.groupId,name:event.name,defaultMode:event.mode};
  if(!GROUP_ID.test(value.id)||!['single','multi'].includes(value.defaultMode)||typeof value.name!=='string'||!value.name||groups.some(group=>group.id===value.id||group.defaultMode===value.defaultMode&&groupNameKey(group.name)===groupNameKey(value.name)))throw new Error('Invalid stored group directory');
  groups.push(Object.freeze(value));
}
function groupsFromEvents(events=[]){const groups=BUILTIN_GROUPS.slice();for(const event of events)if(event.type==='group_created')appendGroup(groups,event);return Object.freeze(groups);}
function createGroupRegistry(db){
  // records_kind already indexes (kind, revision, ordinal). Only new event rows
  // are examined after an observed revision; business histories aren't parsed.
  const read=db.prepare("SELECT json FROM records WHERE kind='events' AND revision>? AND revision<=? AND json_extract(json,'$.type')='group_created' ORDER BY revision,ordinal");
  let revision=-1,barrier=-1,groups=BUILTIN_GROUPS.slice();
  function sync(nextRevision,nextBarrier){
    const reset=revision<0||barrier!==nextBarrier||revision>nextRevision;
    if(reset){revision=-1;groups=BUILTIN_GROUPS.slice();}
    if(revision!==nextRevision){
      const next=groups.slice();for(const row of read.all(revision,nextRevision))appendGroup(next,JSON.parse(row.json));
      groups=next;revision=nextRevision;
    }
    barrier=nextBarrier;return Object.freeze(groups.slice());
  }
  return{sync};
}
module.exports={BUILTIN_GROUPS,GROUP_ID,groupName,groupNameKey,groupModes,groupsFromEvents,createGroupRegistry};
