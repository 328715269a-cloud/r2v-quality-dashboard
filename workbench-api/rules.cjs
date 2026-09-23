'use strict';

const Flow = require('../group-workbench/workflow.js');
const MODES = Object.freeze({ g01:'single',g02:'single',g03:'single',g04:'single',g05:'single',s06:'single',g06:'multi',g07:'multi',g08:'multi',g09:'multi',g10:'multi',m06:'multi',m07:'multi',m08:'multi',m09:'multi',m10:'multi',m11:'multi',m12:'multi' });
const QC_TAGS = new Set(['命名/ID对齐错误','分类/标签归属错误','朝向覆盖缺失（正/侧/背面）','景别/机位/角度/朝向判定错误','AI生成/图片来源异常','ID合并/拆分错误','主体/对象漏标','图片模糊/清晰度不足','黑边/裁切不完整','其他主体混入/画面污染']);
class ApiError extends Error { constructor(status,code,message){super(message);this.status=status;this.code=code;} }
function check(ok,message,code='INVALID_TRANSACTION',status=400){if(!ok)throw new ApiError(status,code,message);}
function object(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function text(value,max=2000,required=false){check(typeof value==='string'||(!required&&value==null),'字段必须是文本');const out=String(value??'').trim();check(out.length<=max&&(!required||out.length>0),'字段为空或过长');check(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(out),'字段包含控制字符');return out;}
function id(value){check(typeof value==='string'&&/^(?:[a-z][a-z0-9_]{0,30}_)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),'记录 ID 无效');return value;}
function chinese(value){const out=text(value,20,true);check(/^\p{Script=Han}{1,20}$/u.test(out),'姓名需要 1 至 20 个中文汉字');return out;}
function date(value){const parsed=typeof value==='string'?Date.parse(value+'T00:00:00Z'):NaN;check(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===value,'日期无效');return value;}
function tid(value){const out=text(value,128,true);check(/^[A-Za-z0-9_-]{1,128}$/.test(out),'TID 格式无效');return out;}
function scope(profile,task,role){check(!role||profile.role===role,'当前身份没有操作权限','FORBIDDEN',403);check(task&&MODES[task.groupId]===task.mode,'小组与模块不匹配');if(profile.role!=='admin'){check(profile.mode===task.mode,'不能跨镜头模块操作','FORBIDDEN',403);if(profile.role!=='acceptance')check(profile.groupId===task.groupId,'只能操作本人小组','FORBIDDEN',403);}}
function manager(profile,task){check(['qc','admin'].includes(profile.role),'需要组长 / 质检或管理员权限','FORBIDDEN',403);scope(profile,task);}
function profileInput(input){check(object(input),'身份格式无效');const role=input.role;check(['annotation','qc','acceptance','admin'].includes(role),'身份无效');if(role==='admin'){check(input.name==='admin','身份或密码不正确','AUTH_FAILED',401);return{name:'admin',role};}const name=chinese(input.name);check(MODES[input.groupId]===input.mode,'请选择正确的镜头类型与小组');return{name,role,mode:input.mode,groupId:input.groupId};}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
// Already-open WorkBuddy pages calculate acceptance rounds before direct flow
// advanced them. Recognize that exact calculation, never an arbitrary stale
// round. The transaction revision and optional task timestamp still must match.
function legacyAcceptanceRound(history){
  let round=0,lastReview=0,packageRound=0;
  const positive=value=>Number.isSafeInteger(value)&&value>0?value:0;
  for(const event of Flow.effectiveEvents(history)){
    if(['package_built','package_claimed'].includes(event.type)&&event.stage==='acceptance'){
      packageRound=positive(event.packageRound)||(event.type==='package_claimed'?packageRound:0)||round+1;
      if(event.type==='package_claimed')round=Math.max(round,packageRound);
    }else if(['qc_pass','qc_repair_done'].includes(event.type))round=Math.max(round,1);
    else if(['sent_acceptance','acceptance_pass','acceptance_fail','acceptance_reject'].includes(event.type)){
      round=Math.max(round,positive(event.acceptanceRound)||positive(event.packageRound)||lastReview+1);
      if(event.type!=='sent_acceptance')lastReview=round;
    }
  }
  return round;
}
function rejectNote(value,marker){const note=text(value,2000,true);check(text(note.startsWith(marker)?note.slice(marker.length):note,2000,true),'请填写拒绝原因');return text(note.startsWith(marker)?note:`${marker} ${note}`,2000,true);}
function snapshot(state,taskId){const raw=state.tasks.find(t=>t.id===taskId);check(raw,'未找到任务');return {...raw,...Flow.project(raw,state.events)};}
// These operations cannot change a task's TID, its existence, or batch links.
// All structural/admin edits keep the full-state validator below.
const RELATED_EVENT_TYPES=new Set(['claim','submit','qc_pass','qc_fail','qc_reject','annotator_reject','reject_confirm','reject_return','acceptance_pass','acceptance_fail','acceptance_reject','acceptance_route','qc_repair_done','admin_reassign']);
function canNormalizeRelated(input){return object(input)&&Object.keys(input).every(key=>['tasks','events','batches'].includes(key))&&[input.tasks,input.batches].every(rows=>rows==null||Array.isArray(rows)&&rows.length===0)&&Array.isArray(input.events)&&input.events.length>0&&input.events.length<=10000&&input.events.every(event=>object(event)&&RELATED_EVENT_TYPES.has(event.type));}
function normalizeDelta(state,input,profile,{pin,checkPin,now,checkDeleteEnabled=()=>check(false,'删除功能尚未开放','IMPORT_DELETE_DISABLED',503),relatedOnly=false,recordExists,clockEvents}){
  check(!relatedOnly||(canNormalizeRelated(input)&&typeof recordExists==='function'),'局部校验上下文无效');
  check(object(input),'缺少操作内容');check(Object.keys(input).every(k=>['tasks','events','batches'].includes(k)),'不能覆盖共享存储字段');
  const raw={};for(const kind of ['tasks','events','batches']){raw[kind]=input[kind]??[];check(Array.isArray(raw[kind])&&raw[kind].length<=10000,'批量内容过大');}
  check(raw.tasks.length+raw.events.length+raw.batches.length<=16000,'请减小本次批量');
  // Import is an administrator action, regardless of PIN or client-side UI.
  // Check all entry points before processing mixed transactions or handoff data.
  if(raw.tasks.length||raw.batches.some(batch=>batch?.kind!=='handoff')||raw.events.some(event=>event?.type==='dispatch'))check(profile.role==='admin','仅管理员可以导入影片任务','FORBIDDEN',403);
  const delta={tasks:[],events:[],batches:[]};const working={...state,tasks:state.tasks.slice(),events:state.events.slice(),batches:state.batches.slice()};
  // Build task histories once. Large imports must not scan every event for every
  // row, and projecting one changed task must not recompute unrelated films.
  const taskMap=new Map(state.tasks.map(t=>[t.id,t])),histories=new Map(state.tasks.map(t=>[t.id,[]])),projected=new Map();
  for(const e of state.events)if(histories.has(e.taskId))histories.get(e.taskId).push(e);
  function view(key){const t=taskMap.get(key);check(t,'未找到任务');if(!projected.has(key))projected.set(key,{...t,...Flow.project(t,histories.get(key)||[])});return projected.get(key);}
  function canBuildLegacyAcceptance(task){
    if(task.status!=='pending_acceptance')return false;
    const history=Flow.effectiveEvents(histories.get(task.id)||[]);
    const entering=history.findLastIndex(event=>['qc_pass','qc_repair_done'].includes(event.type));
    return entering>=0&&!history.slice(entering+1).some(event=>['acceptance_pass','acceptance_fail','acceptance_reject'].includes(event.type)||event.type==='package_built'&&event.stage==='acceptance');
  }
  const canBuild=(task,stage)=>stage==='acceptance'?canBuildLegacyAcceptance(task):Flow.canBuild(task,stage);
  const deletions=raw.events.filter(event=>event?.type==='task_deleted');
  if(deletions.length){
    check(profile.role==='admin','仅管理员可以删除导入记录','FORBIDDEN',403);checkPin(pin,'admin');checkDeleteEnabled();
    check(!raw.tasks.length&&!raw.batches.length&&deletions.length===raw.events.length,'删除不能与导入、修改或作业操作混合');
    const batchId=id(deletions[0].batchId),batch=state.batches.find(item=>item.id===batchId&&item.kind!=='handoff');
    check(batch&&Array.isArray(batch.taskIds)&&batch.taskIds.length>0,'未找到原始导入批次');
    const members=new Set(batch.taskIds),selected=new Set(deletions.map(event=>event.taskId));
    check(members.size===batch.taskIds.length&&selected.size===deletions.length&&selected.size===members.size&&deletions.every(event=>event.batchId===batchId&&members.has(event.taskId)),'只能完整删除一个导入批次，不能遗漏或混入任务');
    check(state.tasks.filter(task=>task.batchId===batchId).length===members.size&&[...members].every(key=>taskMap.get(key)?.batchId===batchId),'导入批次的原始任务关联不完整');
    const reason=text(deletions[0].note,2000,true);check(deletions.every(event=>text(event.note,2000,true)===reason),'同次删除的原因必须一致');
    for(const event of deletions){const task=view(event.taskId);check(!task.deleted,'该导入已删除，请查看导入记录','TASK_DELETED',409);check(typeof event.expectedUpdatedAt==='string'&&event.expectedUpdatedAt===task.updatedAt,'导入任务已有新操作，请重新核对后删除','STATE_CONFLICT',409);}
    check(!state.events.some(event=>members.has(event.taskId)&&!['dispatch','metadata_edit'].includes(event.type)),'本次导入已有作业记录，整批不能删除','BATCH_HAS_ACTIVITY',409);
    check(!state.batches.some(item=>item.kind==='handoff'&&item.taskIds?.some(key=>members.has(key))),'本次导入已关联作业包，整批不能删除','BATCH_HAS_ACTIVITY',409);
  }
  const ids=new Set([...state.tasks,...state.events,...state.batches].map(x=>x.id));
  function fresh(value){check(object(value),'记录格式无效');const key=id(value.id);check(!ids.has(key)&&(!recordExists||!recordExists(key)),'记录 ID 已存在','DUPLICATE_ID',409);ids.add(key);return key;}
  let clock=Math.max(Date.now(),Date.parse(now)||0,...(clockEvents||state.events.slice(-10)).map(e=>(Date.parse(e.at)||0)+1));const stamp=()=>new Date(clock++).toISOString();
  for(const t of raw.tasks){const task={id:fresh(t),tid:tid(t.tid),movie:text(t.movie,200,true),date:date(t.date),groupId:t.groupId,mode:t.mode,batchId:id(t.batchId),createdAt:stamp(),createdBy:profile.name};manager(profile,task);check(!Object.keys(t).some(k=>['status','assignee','round','qcRound','acceptanceRound'].includes(k)),'导入不能预设作业状态');delta.tasks.push(task);working.tasks.push(task);taskMap.set(task.id,task);histories.set(task.id,[]);}
  const newTasks=new Map(delta.tasks.map(t=>[t.id,t]));
  for(const b of raw.batches){const batch={id:fresh(b),date:date(b.date),groupId:b.groupId,mode:b.mode,movie:text(b.movie,200,true),taskIds:b.taskIds,createdAt:stamp(),createdBy:profile.name};manager(profile,batch);check(Array.isArray(batch.taskIds)&&batch.taskIds.length>0&&batch.taskIds.length<=10000&&new Set(batch.taskIds).size===batch.taskIds.length,'批次任务列表无效');batch.taskIds=batch.taskIds.map(id);
    const tasks=batch.taskIds.map(view);check(tasks.every(t=>t.groupId===batch.groupId&&t.mode===batch.mode&&t.movie===batch.movie),'一个批次只允许同影片同组同模块的任务');
    if(b.kind==='handoff'){scope(profile,batch,'qc');check(['qc','acceptance'].includes(b.stage),'建包去向无效');check(tasks.every(t=>canBuild(t,b.stage)),'任务当前不能建包','STATE_CONFLICT',409);Object.assign(batch,{kind:'handoff',stage:b.stage,packageName:text(b.packageName,300,true),tids:tasks.map(t=>t.tid)});}
    else {check(b.kind==null||b.kind==='import','批次类型无效');check(tasks.every(t=>newTasks.has(t.id)&&t.batchId===batch.id&&t.date===batch.date),'导入批次必须对应本次新任务');}
    delta.batches.push(batch);working.batches.push(batch);
  }
  for(const t of delta.tasks)check(delta.batches.some(b=>b.kind!=='handoff'&&b.id===t.batchId&&b.taskIds.includes(t.id)),'导入任务缺少本次导入批次');
  const allowed=new Set(['dispatch','claim','submit','package_built','package_claimed','qc_pass','qc_fail','qc_reject','annotator_reject','reject_confirm','reject_return','acceptance_pass','acceptance_fail','acceptance_reject','acceptance_route','qc_repair_done','metadata_edit','admin_reassign','group_daily_edit','task_deleted']);
  for(const e of raw.events){const eventId=fresh(e);check(allowed.has(e.type),'不支持此操作');check(!e.identityAlias&&!e.legacyName&&!e.targetStatus,'正式模式不接受旧演示身份或跳步状态');let task;
    const event={id:eventId,taskId:e.taskId,type:e.type,workflowVersion:e.assignmentKind==='rework_transfer'?4:3,at:stamp(),actor:profile.name,actorRole:profile.role};const note=text(e.note,2000);if(note)event.note=note;
    if(e.type==='group_daily_edit'){
      const group={groupId:e.groupId,mode:e.mode};manager(profile,group);check(e.taskId===`group:${e.groupId}`,'小组设置 ID 无效');checkPin(pin,'group');event.date=date(e.date);event.groupId=e.groupId;event.mode=e.mode;check(object(e.after)&&object(e.before),'小组设置格式无效');
      const edits=working.events.filter(x=>x.type==='group_daily_edit'&&x.groupId===e.groupId&&x.mode===e.mode);const sameDay=edits.filter(x=>x.date===event.date).at(-1);const leader=edits.filter(x=>x.date<=event.date).sort((a,b)=>a.date.localeCompare(b.date)||a.at.localeCompare(b.at)).at(-1)?.after.leader||'待填写';
      const before={leader,total:sameDay?.after.total??null,headcount:sameDay?.after.headcount??null};check(e.before.leader===before.leader&&e.before.total===before.total&&e.before.headcount===before.headcount,'小组设置已更新，请重新打开','STATE_CONFLICT',409);
      const total=e.after.total,headcount=e.after.headcount;check(Number.isSafeInteger(total)&&total>=0&&total<=999999999,'每日总量无效');check(headcount===null||(Number.isFinite(headcount)&&headcount>=0&&headcount<=9999&&Number.isInteger(headcount*2)),'在班人数无效');Object.assign(event,{before,after:{leader:chinese(e.after.leader),total,headcount},note:text(e.note,2000,true)});
    } else {
      id(e.taskId);task=view(e.taskId);event.tidAtEvent=task.tid;event.movieAtEvent=task.movie;
      check(!task.deleted,'该任务所属导入已删除，请重新查询 TID，当前填写内容已保留','TASK_DELETED',409);
      if(e.expectedUpdatedAt!=null)check(e.expectedUpdatedAt===task.updatedAt,'任务已有新操作，请重新确认','STATE_CONFLICT',409);
      const actionable=['annotating','rework','acceptance_rework'];
      switch(e.type){
        case 'task_deleted':event.batchId=e.batchId;event.note=text(e.note,2000,true);break;
        case 'dispatch':manager(profile,task);check(newTasks.has(task.id)&&!working.events.some(x=>x.taskId===task.id&&x.type==='dispatch'),'只能为本次新任务登记导入');break;
        case 'claim':
          if(e.assignmentKind!=null){check(e.assignmentKind==='rework_transfer','分配类型无效');scope(profile,task,'qc');check(['rework','acceptance_rework'].includes(task.status)&&!!task.assignee,'只能分配待标注返修任务','STATE_CONFLICT',409);check(e.fromAssignee===task.assignee&&e.assignmentStatus===task.status,'任务归属或状态已变化','STATE_CONFLICT',409);const name=chinese(e.assignee);check(name!==task.assignee,'任务已由此人负责');Object.assign(event,{assignmentKind:'rework_transfer',fromAssignee:task.assignee,assignee:name,assignmentStatus:task.status,mode:task.mode,groupId:task.groupId,note:text(e.note,500,true)});}
          else{scope(profile,task,'annotation');check(task.status==='unclaimed'&&!task.assignee,'任务已有处理人或已进入下一环节','STATE_CONFLICT',409);check(!e.assignee||e.assignee===profile.name,'不能认领到他人名下');event.assignee=profile.name;}break;
        case 'submit':scope(profile,task,'annotation');check(actionable.includes(task.status)&&task.assignee===profile.name,'任务当前不属于本人或不可提交','STATE_CONFLICT',409);check(e.round==null||e.round===task.round+1,'标注轮次不一致','STATE_CONFLICT',409);Object.assign(event,{assignee:profile.name,previousAssignee:task.assignee,round:task.round+1,submissionKind:task.round===0?'initial':'rework'});break;
        case 'annotator_reject':scope(profile,task,'annotation');check(actionable.includes(task.status)&&task.assignee===profile.name,'任务当前不能申请拒绝','STATE_CONFLICT',409);Object.assign(event,{assignee:profile.name,previousAssignee:task.assignee,resumeStatus:task.status,note:text(e.note,2000,true)});break;
        case 'package_built':case 'package_claimed':{
          scope(profile,task,'qc');const batch=working.batches.find(b=>b.id===e.packageId&&b.kind==='handoff');check(batch&&batch.taskIds.includes(task.id)&&batch.stage===e.stage&&batch.groupId===task.groupId&&batch.mode===task.mode,'建包记录或关联任务不正确');check(batch.createdBy===profile.name,'只有原建包人可以领取','FORBIDDEN',403);const stage=batch.stage,prefix=stage==='qc'?'qc':'acceptance';let round;
          if(e.type==='package_built'){check(delta.batches.includes(batch)&&canBuild(task,stage),'不能重复建包或跳过作业环节','STATE_CONFLICT',409);round=stage==='acceptance'?task.acceptanceRound:task.qcRound+1;}
          else{check((task.status===`${prefix}_pack_unclaimed`||stage==='acceptance'&&task.status==='pending_acceptance'&&!task.acceptancePackageClaimedAt)&&task[`${prefix}PackageId`]===batch.id,'任务当前不能领取此包','STATE_CONFLICT',409);round=task[`${prefix}PackageRound`];}
          check(e.packageRound===round,'建包轮次不一致','STATE_CONFLICT',409);Object.assign(event,{stage,packageId:batch.id,packageName:batch.packageName,packageRound:round,builder:batch.createdBy});if(e.type==='package_claimed')event.claimer=profile.name;break;
        }
        case 'qc_pass':case 'qc_fail':case 'qc_reject':scope(profile,task,'qc');check(['pending_qc','pending_reqc'].includes(task.status),'任务不在待质检环节','STATE_CONFLICT',409);check((e.qcRound==null||e.qcRound===task.qcRound)&&(e.round==null||e.round===task.qcRound),'质检轮次已变化','STATE_CONFLICT',409);Object.assign(event,{round:task.qcRound,qcRound:task.qcRound});if(e.type==='qc_reject'||Flow.isQcReject({...e,note})){Object.assign(event,{type:'qc_fail',note:rejectNote(note,'[质检拒绝]'),pLevel:'P0',tags:['其他主体混入/画面污染']});}else if(e.type==='qc_fail'){check(['P0','P1','P2'].includes(e.pLevel),'请选择错误等级');check(Array.isArray(e.tags)&&e.tags.length>0&&e.tags.length<=QC_TAGS.size&&new Set(e.tags).size===e.tags.length&&e.tags.every(t=>QC_TAGS.has(t)),'请选择有效错误标签');Object.assign(event,{pLevel:e.pLevel,tags:e.tags.slice(),note:text(e.note,2000,true)});}break;
        case 'reject_confirm':case 'reject_return':scope(profile,task,'qc');check(task.status==='rejection_pending','任务不在拒绝待确认环节','STATE_CONFLICT',409);event.note=text(e.note,2000,true);if(e.type==='reject_return')event.resumeStatus=task.rejectionResumeStatus||'annotating';break;
        case 'acceptance_pass':case 'acceptance_fail':case 'acceptance_reject':scope(profile,task,'acceptance');check(task.status==='pending_acceptance','任务不在待验收环节','STATE_CONFLICT',409);check(e.acceptanceRound==null||e.acceptanceRound===task.acceptanceRound||e.acceptanceRound===legacyAcceptanceRound(histories.get(task.id)||[]),'验收轮次已变化','STATE_CONFLICT',409);event.acceptanceRound=task.acceptanceRound;if(e.type==='acceptance_reject'||Flow.isAcceptanceReject({...e,note}))Object.assign(event,{type:'acceptance_fail',note:rejectNote(note,'[验收拒绝]')});else if(e.type==='acceptance_fail')event.note=text(e.note,2000,true);if(e.source==='acceptance_import')event.source=e.source;break;
        case 'acceptance_route':scope(profile,task,'qc');check(task.status==='acceptance_return_pending','任务不在验收打回待处理环节','STATE_CONFLICT',409);check(['qc','annotation'].includes(e.route),'返修去向无效');event.route=e.route;event.note=text(e.note,2000,true);break;
        case 'qc_repair_done':scope(profile,task,'qc');check(task.status==='qc_self_rework','任务不在质检自行返修环节','STATE_CONFLICT',409);event.note=text(e.note,2000,true);break;
        case 'admin_reassign':{
          manager(profile,task);checkPin(pin,'admin');
          check(['annotation','qc'].includes(e.toRole),'改派角色无效');
          const next=text(e.assignee,20,true);
          check(next!==(task.assignee||''),'新处理人与当前处理人相同');
          event.toRole=e.toRole;event.assignee=next;event.previousAssignee=task.assignee||'';
          break;}
        case 'metadata_edit':manager(profile,task);checkPin(pin,'admin');check(object(e.before)&&object(e.after),'修改内容格式无效');check(e.before.tid===task.tid&&e.before.movie===task.movie,'任务资料已有新修改','STATE_CONFLICT',409);event.before={tid:task.tid,movie:task.movie};event.after={tid:tid(e.after.tid),movie:text(e.after.movie,200,true)};check(!same(event.before,event.after),'内容没有变化');event.note=text(e.note,2000,true);if(e.batchId){const batch=working.batches.find(b=>b.id===e.batchId&&b.kind!=='handoff');check(batch&&batch.taskIds.includes(task.id),'任务不属于该导入批次');event.batchId=batch.id;}break;
      }
    }
    delta.events.push(event);working.events.push(event);if(histories.has(event.taskId)){histories.get(event.taskId).push(event);projected.delete(event.taskId);}
  }
  for(const t of delta.tasks)check(delta.events.filter(e=>e.taskId===t.id&&e.type==='dispatch').length===1,'每条导入任务需要一条导入记录');
  for(const b of delta.batches.filter(x=>x.kind==='handoff'))for(const taskId of b.taskIds)for(const type of ['package_built','package_claimed'])check(delta.events.filter(e=>e.taskId===taskId&&e.packageId===b.id&&e.type===type).length===1,'建包必须同时登记所有所选任务的建包与领取');
  if(!relatedOnly){const finalTids=new Set();for(const task of working.tasks){const current=view(task.id);if(current.deleted)continue;const value=current.tid.toUpperCase();check(!finalTids.has(value),'TID 已存在，整批未保存','DUPLICATE_TID',409);finalTids.add(value);}}
  return delta;
}
module.exports={ApiError,check,object,text,id,chinese,date,profileInput,normalizeDelta,canNormalizeRelated,snapshot,MODES};
